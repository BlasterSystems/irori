import { z } from "zod";

/**
 * Curated serving recipes (IRI-082, epic IR-157 WS6). Irori has no recipe
 * abstraction: serving is user-owned start/stop scripts
 * (docs/SPEC.md "No generated serve commands"), and
 * `setupCreateSchema` (packages/core/src/setups.ts) is the only serving
 * contract. A curated catalog is therefore a hub-side library of pre-filled
 * setup drafts — no new execution model.
 *
 * Two flavours:
 *  - `miaai-script` — Mia's AI Lab recipe repos: start.sh/stop.sh + env plus
 *    a fixed port, which maps one-to-one onto setupCreateSchema.
 *  - `sparkrun-transpiled` — sparkrun v2 YAML, transpiled at import time into
 *    a generated start/stop pair with provenance. Irori never executes
 *    third-party YAML and never shells out to sparkrun.
 *
 * License hygiene: upstream recipes are mixed MIT/Apache/AGPL-3.0. AGPL
 * script bodies are never vendored into the bundle — the entry stores a
 * pinned URL and the agent stages the file at install time, checksum-first.
 */

export const RECIPE_KINDS = ["miaai-script", "sparkrun-transpiled"] as const;
export const recipeKindSchema = z.enum(RECIPE_KINDS);
export type RecipeKind = z.infer<typeof recipeKindSchema>;

/** Engine family — decides which llm-probe applier will recognize it. */
export const RECIPE_ENGINES = ["tensorfold", "vllm", "sglang", "llama.cpp", "other"] as const;
export const recipeEngineSchema = z.enum(RECIPE_ENGINES);
export type RecipeEngine = z.infer<typeof recipeEngineSchema>;

export const recipeEnvKeySchema = z.object({
  key: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/, "env keys are upper snake case"),
  /** Human label for the wizard chip. */
  label: z.string().max(96).default(""),
  kind: z.enum(["string", "int", "bool", "enum"]).default("string"),
  default: z.union([z.string(), z.number(), z.boolean()]).nullable().default(null),
  options: z.array(z.string()).default([]),
  required: z.boolean().default(false),
  help: z.string().max(512).default(""),
});
export type RecipeEnvKey = z.infer<typeof recipeEnvKeySchema>;

export const recipeSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1).max(96),
  name: z.string().min(1).max(160),
  author: z.string().max(160),
  kind: recipeKindSchema,
  engine: recipeEngineSchema,
  summary: z.string().max(1024).default(""),
  upstreamUrl: z.string().url().max(2048),
  /** Pinned commit SHA — provenance for everything staged from upstream. */
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  license: z.string().max(64),
  /** True when the upstream license is copyleft: never vendored, only staged. */
  copyleft: z.boolean().default(false),
  defaultPort: z.number().int().positive().max(65535).default(8888),
  modelRepo: z.string().max(256).nullable().default(null),
  modelRevision: z.string().max(128).nullable().default(null),
  envKeys: z.array(recipeEnvKeySchema).default([]),
  /** Serving topology the recipe expects. */
  nodeCountMin: z.number().int().positive().default(1),
  nodeCountMax: z.number().int().positive().default(1),
  scriptStart: z.string().max(256).default("start.sh"),
  scriptStop: z.string().max(256).default("stop.sh"),
  /** Present for sparkrun-transpiled entries. */
  provenance: z
    .object({
      registry: z.string().max(160),
      repo: z.string().max(256),
      recipeName: z.string().max(160),
      runtime: z.string().max(64),
    })
    .nullable()
    .default(null),
  startupTimeoutMs: z.number().int().positive().default(600_000),
  releaseNotesUrl: z.string().url().max(2048).nullable().default(null),
  forumTopicId: z.string().max(64).nullable().default(null),
  /** Community-reported performance, attributed, never a claim by Irori. */
  measured: z
    .array(z.object({ label: z.string().max(96), value: z.string().max(96), source: z.string().max(256) }))
    .default([]),
  catalogVersion: z.number().int().nonnegative().default(1),
  fetchedAt: z.string(),
  hidden: z.boolean().default(false),
  curated: z.boolean().default(true),
  /** Commits on upstream since `commitSha`, from the Atom watch (IRI-083). */
  behindCommits: z.number().int().nonnegative().nullable().default(null),
  /** Releases of the engine repo since the recipe was pinned. */
  engineReleasesBehind: z.number().int().nonnegative().nullable().default(null),
});
export type Recipe = z.infer<typeof recipeSchema>;

export const recipesResponseSchema = z.object({
  recipes: z.array(recipeSchema),
  /** Seed file version shipped in-repo; lets the UI flag a stale catalog. */
  seedVersion: z.number().int().nonnegative(),
});
export type RecipesResponse = z.infer<typeof recipesResponseSchema>;

/**
 * The draft a recipe install produces. Deliberately a superset-compatible
 * shape with setupCreateSchema so the wizard can pre-fill and the operator
 * confirms: nothing auto-starts, and capture is on by default.
 */
export const recipeInstallSchema = z.object({
  name: z.string().min(1).max(128),
  port: z.number().int().positive().max(65535),
  kind: z.enum(["single", "cluster"]),
  headNodeId: z.string().uuid(),
  workerNodeIds: z.string().uuid().array().max(7).default([]),
  envExports: z.record(z.string(), z.string()).default({}),
  /** Always true for curated installs: usage capture is the point. */
  captureProxy: z.boolean().default(true),
  bodyRetention: z.boolean().default(false),
  startupTimeoutMs: z.number().int().positive().default(600_000),
  /** Staged script paths on the node (agent-staged, checksum-verified). */
  scriptStart: z.string().max(512),
  scriptStop: z.string().max(512),
  recipeId: z.string().uuid(),
});
export type RecipeInstall = z.infer<typeof recipeInstallSchema>;

export const recipeInstallResponseSchema = z.object({
  setupId: z.string().uuid(),
  /** Checksum of each staged file, so the operator can verify what ran. */
  staged: z.object({ startSha256: z.string(), stopSha256: z.string() }),
});

/** POST /recipes/:id/install body: where to stage the draft. */
export const recipeInstallRequestSchema = z.object({
  headNodeId: z.string().uuid(),
  port: z.number().int().positive().max(65535).nullable().optional(),
});
export type RecipeInstallResponse = z.infer<typeof recipeInstallResponseSchema>;

/**
 * The two caveats every curated card must state — these are real, measured
 * behaviours, not boilerplate:
 *  - IR-151: engines that daemonize (docker run -d) with a start script that
 *    exits 0 after readiness can have their setup row demoted to stopped
 *    while the engine is live. The port truth, not the row, is authoritative.
 *  - capture endpoints: clients pointed at a bare base URL (no /v1) are
 *    forwarded and captured only when the endpoint pattern matches
 *    CAPTURED_ENDPOINT_RE (packages/core/src/usage.ts). A provider configured
 *    with an unusual path is forwarded but silently uncaptured.
 */
export const RECIPE_CAVEATS = [
  {
    id: "ir151-status-demotion",
    text: "Engines that daemonize (docker run -d) can have their setup row show stopped while the engine is live; the port probe, not the row, is the truth.",
  },
  {
    id: "capture-endpoints",
    text: "Capture records requests on the OpenAI endpoint paths (with or without the /v1 prefix). A client pointed at an unusual path is forwarded but never captured, so its usage is invisible.",
  },
] as const;
