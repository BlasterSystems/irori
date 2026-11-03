import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { jobs, jobOutput } from "@irori/db";
import { recipeCatalog, type Db } from "@irori/db";
import { recipeInstallParamsSchema, recipeInstallSchema, type RecipeInstall, type RecipeInstallParams } from "@irori/core";
import seedJson from "./recipe-seed.json" with { type: "json" };

/**
 * IRI-082: curated recipe catalog (SparkRun + MiaAI). Seeds live in-repo
 * (recipe-seed.json, versioned) and upsert on boot; hub-managed additions
 * ride the API. Script bodies are NEVER vendored into the bundle — the hub
 * stages content onto the node via a recipe-install job and the agent
 * verifies the sha256 before writing. AGPL entries pass through the hub at
 * install time only. Nothing auto-starts: a settled install yields a draft
 * the operator confirms through the normal setup wizard.
 */

type RecipeRow = typeof recipeCatalog.$inferSelect;

interface SeedFile {
  catalogVersion: number;
  entries: Array<Omit<RecipeRow, "id" | "fetchedAt" | "hidden" | "curated" | "behindCommits" | "engineReleasesBehind" | "releaseNotesUrl" | "forumTopicId">>;
}

const SEED = seedJson as unknown as SeedFile;
export const RECIPE_CATALOG_VERSION = SEED.catalogVersion;

export async function seedRecipes(db: Db): Promise<void> {
  for (const e of SEED.entries) {
    await db
      .insert(recipeCatalog)
      .values({ ...e, scriptStop: e.scriptStop === "" ? "stop.sh" : e.scriptStop, catalogVersion: SEED.catalogVersion })
      .onConflictDoUpdate({
        // Curated metadata refreshes; hub-managed flags (hidden) and pins stay.
        target: recipeCatalog.slug,
        set: {
          name: e.name,
          author: e.author,
          kind: e.kind,
          engine: e.engine,
          summary: e.summary,
          upstreamUrl: e.upstreamUrl,
          license: e.license,
          copyleft: e.copyleft,
          defaultPort: e.defaultPort,
          modelRepo: e.modelRepo,
          envKeys: e.envKeys,
          nodeCountMin: e.nodeCountMin,
          nodeCountMax: e.nodeCountMax,
          scriptStart: e.scriptStart,
          scriptStop: e.scriptStop,
          provenance: e.provenance,
          startupTimeoutMs: e.startupTimeoutMs,
          catalogVersion: SEED.catalogVersion,
        },
      });
  }
  // Best-effort pin pass: unpinned seeds get the latest upstream SHA once.
  void (async () => {
    for (const e of SEED.entries) {
      if (e.commitSha !== "") continue;
      try {
        const sha = await pinLatestSha(e.upstreamUrl, fetch);
        if (sha === null) continue;
        await db.update(recipeCatalog).set({ commitSha: sha, fetchedAt: new Date() }).where(eq(recipeCatalog.slug, e.slug));
      } catch {
        /* offline: entries stay unpinned and hidden from the catalog */
      }
    }
  })();
}

/** Pin = latest default-branch commit SHA (GitHub API, unauthenticated). */
export async function pinLatestSha(repoUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(repoUrl);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, "")}/commits?per_page=1`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "irori" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ sha?: string }>;
    return typeof arr[0]?.sha === "string" ? arr[0].sha : null;
  } catch {
    return null;
  }
}

/**
 * Minimal sparkrun v2 YAML transpilation: derive a start/stop script pair
 * from the recipe's model/container/port. Irori never executes third-party
 * YAML and never shells out to sparkrun — one execution model (setup
 * scripts), provenance kept in the entry.
 */
export function transpileSparkrun(yaml: string, slug: string): { start: string; stop: string } | null {
  const pick = (key: string): string | null => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(yaml);
    if (m === null) return null;
    return m[1]!.trim().replace(/^["']|["']$/g, "");
  };
  const model = pick("model");
  const container = pick("container");
  if (model === null && container === null) return null;
  const port = pick("port") ?? "8000";
  const lines = [
    "#!/usr/bin/env bash",
    `# Transpiled from a sparkrun v2 recipe (slug ${slug}) — Irori IRI-082.`,
    "# IR-151 note: daemonized engines + exiting start scripts are subject to status demotion; trust the port truth.",
    "set -euo pipefail",
    `PORT="\${PORT:-${port}}"`,
  ];
  if (model !== null) lines.push(`MODEL="\${MODEL:-${model}}"`);
  if (container !== null) {
    lines.push(
      `docker run -d --rm --name irori-${slug} --shm-size=16g -p "\${PORT}:\${PORT}" ${container} \\`,
      model === null ? `  --port "\${PORT}" --host 0.0.0.0 "\${EXTRA_ARGS:-}"` : `  --model "\${MODEL}" --port "\${PORT}" --host 0.0.0.0 "\${EXTRA_ARGS:-}"`,
    );
  }
  const start = [...lines, ""].join("\n");
  const stop = ["#!/usr/bin/env bash", `docker stop irori-${slug} 2>/dev/null || true`, ""].join("\n");
  return { start, stop };
}

export async function fetchRawFile(repoUrl: string, sha: string, relPath: string, fetchImpl: typeof fetch): Promise<string | null> {
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(repoUrl);
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  try {
    const res = await fetchImpl(`https://raw.githubusercontent.com/${m[1]}/${m[2].replace(/\.git$/, "")}/${sha}/${relPath}`, {
      headers: { "user-agent": "irori" },
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** Stage payload for a recipe-install job (content + sha256 per file). */
export async function buildStageParams(entry: RecipeRow, fetchImpl: typeof fetch): Promise<RecipeInstallParams | null> {
  const dir = `/opt/irori/recipes/${entry.slug}`;
  if (entry.commitSha === "") return null;
  const files: RecipeInstallParams["files"] = [];
  const add = (rel: string, content: string): void => {
    files.push({ rel, content, sha256: createHash("sha256").update(content).digest("hex") });
  };
  if (entry.kind === "sparkrun-transpiled") {
    const yamlPath = entry.scriptStart.endsWith(".yaml") ? entry.scriptStart : "recipe.yaml";
    const yaml = await fetchRawFile(entry.upstreamUrl, entry.commitSha, yamlPath, fetchImpl);
    if (yaml === null) return null;
    const t = transpileSparkrun(yaml, entry.slug);
    if (t === null) return null;
    add("start.sh", t.start);
    add("stop.sh", t.stop);
  } else {
    const start = await fetchRawFile(entry.upstreamUrl, entry.commitSha, entry.scriptStart, fetchImpl);
    if (start === null) return null;
    add("start.sh", start);
    const stop = await fetchRawFile(entry.upstreamUrl, entry.commitSha, entry.scriptStop, fetchImpl);
    add("stop.sh", stop ?? "#!/usr/bin/env bash\ntrue\n");
  }
  const parsed = recipeInstallParamsSchema.safeParse({ dir, files });
  return parsed.success ? parsed.data : null;
}

export async function getRecipe(db: Db, id: string) {
  const [row] = await db.select().from(recipeCatalog).where(eq(recipeCatalog.id, id)).limit(1);
  return row ?? null;
}

export interface RecipeInstallRequest {
  headNodeId: string;
  port?: number | null;
}

export interface RecipeService {
  list(): Promise<{ recipes: Array<RecipeRow>; seedVersion: number }>;
  setHidden(id: string, hidden: boolean): Promise<void>;
  pin(id: string): Promise<string | null>;
  install(id: string, req: RecipeInstallRequest): Promise<string>;
  /** Draft for the settled job (operator confirms via the setup wizard). */
  draft(jobId: string): Promise<RecipeInstall | null>;
}

export function createRecipesService(db: Db, opts: { createJob: (nodeId: string, kind: string, params: unknown) => Promise<{ id: string }> }): RecipeService {
  return {
    async list() {
      // Unpinned entries (offline boot) stay hidden until the pin pass lands.
      const rows = await db.select().from(recipeCatalog).where(and(eq(recipeCatalog.hidden, false))).orderBy(recipeCatalog.kind, recipeCatalog.name);
      return { recipes: rows.filter((r) => r.commitSha !== ""), seedVersion: RECIPE_CATALOG_VERSION };
    },
    async setHidden(id, hidden) {
      await db.update(recipeCatalog).set({ hidden }).where(eq(recipeCatalog.id, id));
    },
    async pin(id) {
      const entry = await getRecipe(db, id);
      if (entry === null) return null;
      const sha = await pinLatestSha(entry.upstreamUrl, fetch);
      if (sha === null) return null;
      await db.update(recipeCatalog).set({ commitSha: sha, fetchedAt: new Date() }).where(eq(recipeCatalog.id, id));
      return sha;
    },
    async install(id, req) {
      const entry = await getRecipe(db, id);
      if (entry === null) throw new Error("recipe not found");
      if (entry.commitSha === "") {
        const sha = await pinLatestSha(entry.upstreamUrl, fetch);
        if (sha === null) throw new Error("recipe is unpinned and the upstream pin failed");
        await db.update(recipeCatalog).set({ commitSha: sha, fetchedAt: new Date() }).where(eq(recipeCatalog.id, id));
        entry.commitSha = sha;
      }
      const params = await buildStageParams(entry, fetch);
      if (params === null) throw new Error("recipe staging failed (upstream fetch)");
      const job = await opts.createJob(req.headNodeId, "recipe-install", {
        ...params,
        meta: { recipeId: entry.id, slug: entry.slug, name: entry.name, port: req.port ?? entry.defaultPort, model: entry.modelRepo ?? entry.slug, minNodes: entry.nodeCountMin, startupTimeoutMs: entry.startupTimeoutMs },
      });
      return job.id;
    },
    async draft(jobId) {
      const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (job === undefined || job.kind !== "recipe-install" || job.status !== "succeeded") return null;
      const params = job.params as RecipeInstallParams & { meta?: { recipeId: string; slug: string; name: string; port: number; model: string; minNodes: number; startupTimeoutMs: number } };
      if (params.meta === undefined) return null;
      const output = await db.select({ line: jobOutput.line }).from(jobOutput).where(eq(jobOutput.jobId, jobId)).orderBy(desc(jobOutput.seq)).limit(10);
      const pathsLine = output.map((o) => o.line).find((l) => l.includes("paths"));
      if (pathsLine === undefined) return null;
      let paths: string[];
      try {
        paths = (JSON.parse(pathsLine) as { paths: string[] }).paths;
      } catch {
        return null;
      }
      if (!Array.isArray(paths) || paths.length < 2) return null;
      const draft = {
        name: params.meta.name,
        port: params.meta.port,
        kind: params.meta.minNodes > 1 ? ("cluster" as const) : ("single" as const),
        headNodeId: job.nodeId,
        workerNodeIds: [],
        envExports: {},
        captureProxy: true,
        bodyRetention: false,
        startupTimeoutMs: params.meta.startupTimeoutMs,
        scriptStart: paths[0]!,
        scriptStop: paths[1]!,
        recipeId: params.meta.recipeId,
      };
      return recipeInstallSchema.parse(draft);
    },
  };
}
