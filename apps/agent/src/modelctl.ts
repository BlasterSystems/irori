import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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
  const lines: string[] = ["downloads:"];
  for (const e of entries) {
    if (!e || typeof e.source !== "string" || e.source.length === 0) {
      throw new CommandBuildError("every download entry needs a source");
    }
    lines.push(`  - source: ${e.source}`);
    const opt = (key: string, value: unknown) => {
      if (value === undefined || value === null || value === "") return;
      lines.push(`    ${key}: ${value}`);
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

/** Builds the argv for a job kind. Throws CommandBuildError on invalid params. */
export function buildCommand(kind: string, params: Record<string, unknown>, ctx: ModelctlCtx): { argv: string[]; shell?: string } {
  const modelctl = ctx.modelctlPath ?? "modelctl";
  const built = buildKindArgs(kind, params, ctx);
  if (built.shell !== undefined) return built;
  return { argv: [modelctl, ...built.argv] };
}

function buildKindArgs(kind: string, params: Record<string, unknown>, ctx: ModelctlCtx): { argv: string[]; shell?: string } {
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
      // Provisioning (ADR-0004): uv → pinned GitHub release → version gate.
      const script = [
        "set -e",
        "command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh",
        `uv tool install --force piresbruno/modelctl`,
        `modelctl --version`,
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
      return { argv };
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
      return { argv };
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
      return { argv: ["delete-local", name] };
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
  const onLine = (buf: Buffer) => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (line.length > 0) opts.onLine(line);
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
