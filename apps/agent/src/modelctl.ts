import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * modelctl command building + execution (ADR-0004: Irori never mutates the
 * store except through modelctl). Destructive kinds are separate dry-run /
 * armed jobs; the armed variant passes --apply --yes explicitly.
 */

export interface ModelctlCtx {
  /** NAS store root for model-ops nodes (from the node record). */
  nasRoot: string | null;
  /** Pinned minimum version for the install job. */
  pin: string;
  /** Explicit modelctl binary (uv installs to ~/.local/bin, off the default PATH). */
  modelctlPath?: string;
  /** IRI-017: HF token handed to modelctl as HF_TOKEN (gated/private repos); empty = unset. */
  hfToken?: string;
  /** The agent's own user (root); its local cache runs without runuser. */
  agentUser?: string;
  /** IRI-028: resolves a cache owner for delete-local; null when unknown. */
  resolveLocalUser?: (user: string) => { home: string; binary: string } | null;
  /** IR-101: the node's cache owner for transfers; null/absent = agent user. */
  cacheUser?: string | null;
}

export class CommandBuildError extends Error {}

/** Queue-entry fields accepted for download jobs (form-built; raw YAML rejected). */
export interface DownloadEntry {
  source: string;
  name?: string;
  revision?: string;
  quantization?: string;
  runtime?: "auto" | "vllm" | "llama.cpp";
  mmproj?: string;
  mtp?: string;
  force?: boolean;
}

/** Emits the modelctl queue YAML (exactly one `downloads:` key; entries in field order). */
export function buildQueueYaml(entries: DownloadEntry[]): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new CommandBuildError("downloads must be a non-empty list");
  }
  // JSON string literals are valid YAML double-quoted scalars (same escapes),
  // so quoting defeats newline/key injection from model or source strings.
  const ystr = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : String(v));
  const lines: string[] = ["downloads:"];
  for (const e of entries) {
    if (!e || typeof e.source !== "string" || e.source.length === 0) {
      throw new CommandBuildError("every download entry needs a source");
    }
    lines.push(`  - source: ${ystr(e.source)}`);
    const opt = (key: string, value: unknown) => {
      if (value === undefined || value === null || value === "") return;
      lines.push(`    ${key}: ${ystr(value)}`);
    };
    opt("name", e.name);
    opt("revision", e.revision);
    opt("quantization", e.quantization);
    opt("runtime", e.runtime);
    opt("mmproj", e.mmproj);
    opt("mtp", e.mtp);
    if (e.force === true) lines.push("    force: true");
  }
  return lines.join("\n") + "\n";
}

const ROOT_FLAG = "--root";

/**
 * IR-101: transfers must land in the node's cache owner's HF cache — the
 * registration state lives in the invoking user's home, so running as root
 * with --cache-dir pointed at a user path would split state. When the node has
 * a cache user, wrap modelctl in runuser with a scrubbed env (the IRI-028
 * delete-local pattern). Home/binary resolve agent-side; the hub never sends
 * paths. A missing user modelctl fails the build with an actionable error —
 * it must never silently fall back to root's cache.
 */
function asCacheUser(argv: string[], ctx: ModelctlCtx, kind: string): { argv: string[]; raw?: boolean } {
  const user = ctx.cacheUser?.trim();
  if (!user || user === (ctx.agentUser ?? "root")) return { argv };
  const resolved = ctx.resolveLocalUser?.(user) ?? null;
  if (resolved === null) {
    throw new CommandBuildError(
      `${kind}: no modelctl for cache user "${user}" — install it for that user (sudo -u ${user} uv tool install "modelctl") or clear the node's cache user setting`,
    );
  }
  return {
    raw: true,
    argv: [
      "runuser",
      "-u",
      user,
      "--",
      "env",
      "-u",
      "XDG_STATE_HOME",
      "-u",
      "HF_HOME",
      "-u",
      "HF_HUB_CACHE",
      `HOME=${resolved.home}`,
      `PATH=${dirname(resolved.binary)}:/usr/local/bin:/usr/bin:/bin`,
      resolved.binary,
      ...argv,
    ],
  };
}

/** Builds the argv for a job kind. Throws CommandBuildError on invalid params. */
export function buildCommand(kind: string, params: Record<string, unknown>, ctx: ModelctlCtx): { argv: string[]; shell?: string; raw?: boolean } {
  const modelctl = ctx.modelctlPath ?? "modelctl";
  const built = buildKindArgs(kind, params, ctx);
  // `raw` kinds already carry their executable (e.g. a runuser wrapper).
  if (built.shell !== undefined || built.raw === true) return built;
  return { argv: [modelctl, ...built.argv] };
}

function buildKindArgs(kind: string, params: Record<string, unknown>, ctx: ModelctlCtx): { argv: string[]; shell?: string; raw?: boolean } {
  const str = (key: string): string | undefined => {
    const v = params[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const num = (key: string): number | undefined => {
    const v = params[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const bool = (key: string): boolean => params[key] === true;
  const root = (): string => {
    const r = str("root") ?? ctx.nasRoot;
    if (!r) throw new CommandBuildError(`job "${kind}" needs a NAS store root (node nasRoot or params.root)`);
    return r;
  };

  switch (kind) {
    case "modelctl-install": {
      // Provisioning (ADR-0004): uv → pinned GitHub release tag → version
      // gate. ~/.local/bin is off PATH on the shipped image (IRORI_MODELCTL_PATH
      // exists for exactly that reason) — export it or nothing here works.
      if (!/^\d+\.\d+\.\d+$/.test(ctx.pin)) {
        throw new CommandBuildError(`IRORI_MODELCTL_PIN must be semver, got "${ctx.pin}"`);
      }
      const script = [
        "set -e",
        // The agent unit sets no HOME (systemd default for root) — a $HOME
        // export degrades to "/.local/bin" and uv is never found (exit 127).
        // The uv installer itself lands in /root/.local/bin for the root agent.
        'export PATH="/root/.local/bin:$PATH"',
        "command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh",
        `uv tool install --force "git+https://github.com/piresbruno/modelctl@v${ctx.pin}"`,
        `INSTALLED="$(modelctl --version | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"`,
        `[ -n "$INSTALLED" ] || { echo "modelctl --version produced no version"; exit 1; }`,
        `LOWEST="$(printf '%s\\n' "$INSTALLED" "${ctx.pin}" | sort -V | head -n1)"`,
        `[ "$LOWEST" = "${ctx.pin}" ] || { echo "modelctl $INSTALLED is older than required ${ctx.pin}"; exit 1; }`,
        `echo "modelctl $INSTALLED satisfies the ${ctx.pin} gate"`,
      ].join("\n");
      return { argv: ["bash", "-c", script], shell: "bash" };
    }
    case "download-queue": {
      const entries = params.downloads;
      if (!Array.isArray(entries)) throw new CommandBuildError("download-queue params.downloads must be a list");
      const yaml = buildQueueYaml(entries as DownloadEntry[]);
      const tmp = join(tmpdir(), `irori-queue-${randomUUID()}.yaml`);
      writeFileSync(tmp, yaml, { mode: 0o600 });
      const argv = ["queue", tmp];
      const jobs = num("jobs");
      if (jobs) argv.push("--jobs", String(Math.floor(jobs)));
      argv.push(ROOT_FLAG, root());
      // Best-effort cleanup once the process is gone; modelctl reads it at start.
      setTimeout(() => rmSync(tmp, { force: true }), 60_000).unref();
      return { argv };
    }
    case "sync-local": {
      const target = str("name") ?? str("repository");
      if (!target) throw new CommandBuildError("sync-local needs name or repository");
      const argv = ["sync-local", target];
      argv.push("--source-root", root());
      const jobs = num("jobs");
      if (jobs) argv.push("--jobs", String(Math.floor(jobs)));
      const cache = str("cacheDir");
      if (cache) argv.push("--cache-dir", cache);
      return asCacheUser(argv, ctx, "sync-local");
    }
    case "download":
    case "install": {
      const name = str("name") ?? str("repository");
      if (!name) throw new CommandBuildError(`${kind} needs name or repository`);
      return { argv: ["download", name] };
    }
    case "push": {
      const name = str("name") ?? str("repository");
      if (!name) throw new CommandBuildError("push needs name or repository");
      const hosts = Array.isArray(params.hosts) ? params.hosts.filter((h): h is string => typeof h === "string" && h.length > 0) : [];
      if (hosts.length === 0) throw new CommandBuildError("push needs at least one --host");
      const argv = ["push", name];
      for (const h of hosts) argv.push("--host", h);
      const jobs = num("jobs");
      if (jobs) argv.push("--jobs", String(Math.floor(jobs)));
      const cache = str("cacheDir");
      if (cache) argv.push("--cache-dir", cache);
      const ssh = str("ssh");
      if (ssh) argv.push("--ssh", ssh);
      return asCacheUser(argv, ctx, "push");
    }
    case "nas-delete": {
      const name = str("name");
      if (!name) throw new CommandBuildError("nas-delete needs name");
      return { argv: ["delete", name, ROOT_FLAG, root()] };
    }
    case "nas-delete-apply": {
      const name = str("name");
      if (!name) throw new CommandBuildError("nas-delete-apply needs name");
      return { argv: ["delete", name, "--apply", "--yes", ROOT_FLAG, root()] };
    }
    case "delete-local": {
      const name = str("name");
      if (!name) throw new CommandBuildError("delete-local needs name");
      const user = str("user");
      if (user === undefined || user === (ctx.agentUser ?? "root")) {
        return { argv: ["delete-local", name] };
      }
      // A modelctl local registration lives in the invoking user's state dir;
      // a root agent must run the delete as the cache owner (IRI-028). The
      // home/binary are resolved agent-side — the hub never sends paths.
      const resolved = ctx.resolveLocalUser?.(user) ?? null;
      if (resolved === null) {
        throw new CommandBuildError(`delete-local: unknown local cache user "${user}"`);
      }
      return {
        raw: true,
        argv: [
          "runuser",
          "-u",
          user,
          "--",
          "env",
          "-u",
          "XDG_STATE_HOME",
          "-u",
          "HF_HOME",
          "-u",
          "HF_HUB_CACHE",
          `HOME=${resolved.home}`,
          `PATH=${dirname(resolved.binary)}:/usr/local/bin:/usr/bin:/bin`,
          resolved.binary,
          "delete-local",
          name,
        ],
      };
    }
    case "register-local": {
      const name = str("name");
      if (!name) throw new CommandBuildError("register-local needs name");
      const user = str("user");
      // IR-104: register-local verifies the existing cache entry against the
      // store (blob-identity plus small-file hashes) and writes the
      // registration without transferring blobs — needs the store root.
      const core = ["register-local", name, "--source-root", root()];
      if (user === undefined || user === (ctx.agentUser ?? "root")) {
        return { argv: core };
      }
      // Same per-user rule as delete-local: the registration lives in the
      // invoking user's state dir, so a root agent runs it as the cache owner.
      const resolved = ctx.resolveLocalUser?.(user) ?? null;
      if (resolved === null) {
        throw new CommandBuildError(`register-local: unknown local cache user "${user}"`);
      }
      return {
        raw: true,
        argv: [
          "runuser",
          "-u",
          user,
          "--",
          "env",
          "-u",
          "XDG_STATE_HOME",
          "-u",
          "HF_HOME",
          "-u",
          "HF_HUB_CACHE",
          `HOME=${resolved.home}`,
          `PATH=${dirname(resolved.binary)}:/usr/local/bin:/usr/bin:/bin`,
          resolved.binary,
          ...core,
        ],
      };
    }
    case "doctor":
      return { argv: ["doctor", "--json", ROOT_FLAG, root()] };
    case "repair-active": {
      const name = str("name");
      const argv = ["repair-active"];
      if (name) argv.push(name);
      argv.push(ROOT_FLAG, root());
      return { argv };
    }
    case "repair-active-apply": {
      const name = str("name");
      const argv = ["repair-active"];
      if (name) argv.push(name);
      argv.push("--apply", ROOT_FLAG, root());
      return { argv };
    }
    case "staging-audit":
      return { argv: ["staging-audit", "--root", root()] };
    case "objects-audit":
      return { argv: ["objects-audit", "--root", root()] };
    case "cleanup-staging":
    case "gc-objects": {
      const verb: string = kind;
      const targets = Array.isArray(params.targets) ? params.targets.filter((t): t is string => typeof t === "string") : [];
      if (targets.length === 0) throw new CommandBuildError(`${verb} needs targets`);
      const argv: string[] = [verb];
      for (const t of targets) argv.push(t);
      if (bool("apply")) argv.push("--apply");
      argv.push(ROOT_FLAG, root());
      return { argv };
    }
    case "catalog-refresh":
      return { argv: ["catalog", "refresh", ROOT_FLAG, root()] };
    case "sync-cards": {
      const argv = ["sync-cards"];
      const names = Array.isArray(params.names) ? params.names.filter((n): n is string => typeof n === "string") : [];
      for (const n of names) argv.push(n);
      if (bool("force")) argv.push("--force");
      argv.push(ROOT_FLAG, root());
      return { argv };
    }
    default:
      throw new CommandBuildError(`unknown job kind: ${kind}`);
  }
}

export interface RunOutcome {
  exitCode: number | null;
  canceled: boolean;
}

/**
 * Runs a command, streaming lines to onLine. Resolves on exit. cancel() sends
 * SIGTERM to the process group, then SIGKILL after 5 s.
 */
export function runStreaming(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; onLine: (line: string) => void },
): { done: Promise<RunOutcome>; cancel: () => void } {
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd,
  });
  let canceled = false;
  let lastProgressAt = 0;
  const onLine = (buf: Buffer) => {
    for (const line of buf.toString("utf8").split(/\r\n|\r|\n/)) {
      if (line.length === 0) continue;
      // Progress repaints flood the output ring and the SSE stream — rsync
      // --info=progress2 repaints one line via \r, huggingface_hub tqdm bars
      // stream per-refresh lines: throttle all of them to 1/s.
      if (/\d+\s*%/.test(line) && (/B\/s/.test(line) || /it\/s/.test(line) || /s\/it/.test(line))) {
        const now = Date.now();
        if (now - lastProgressAt < 1000) continue;
        lastProgressAt = now;
      }
      opts.onLine(line);
    }
  };
  child.stdout?.on("data", onLine);
  child.stderr?.on("data", onLine);
  // Resolve on EXIT, not on stdio close: a detached process group can leave
  // an orphaned child holding the pipes (modelctl workers), which would hang
  // a close-based await forever.
  const done = new Promise<RunOutcome>((resolve) => {
    child.on("exit", (code) => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ exitCode: code, canceled });
    });
    child.on("error", (err: Error) => {
      opts.onLine(`error: spawn failed: ${err.message}`);
      resolve({ exitCode: -1, canceled });
    });
  });
  return {
    done,
    cancel: () => {
      canceled = true;
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGTERM");
          setTimeout(() => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {}
          }, 5_000).unref();
        } catch {}
      }
    },
  };
}
