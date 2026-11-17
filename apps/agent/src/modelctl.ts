import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { MODELCTL_PIN_RE } from "@irori/core";
import { runuserWrap } from "./cache-user.js";

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
  /** IR-247: resolves a cache owner's passwd home only — separates "no
   *  passwd entry" (unknown) from "no per-user modelctl" (actionable). */
  resolveCacheHome?: (user: string) => string | null;
  /** IR-101: the node's cache owner for transfers; null/absent = agent user. */
  cacheUser?: string | null;
  /** IR-207: download floor in bytes on the store's free space (0/absent disables);
   *  passed through as modelctl's --min-free-bytes for download and queue. */
  minStoreFreeBytes?: number;
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

/** Single-quote a value for safe embedding in a generated bash script. */
function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Destination probe (ADR-0014): report the destination's modelctl binary at
 * the ADR-0011 candidate paths plus rsync presence. Runs via `ssh host sh -c`
 * from the preflight; the caller classifies the ssh returncode/stderr.
 */
const REMOTE_PROBE =
  'cd; M=""; for p in "$HOME/.local/bin/modelctl" /usr/local/bin/modelctl /usr/bin/modelctl; do [ -x "$p" ] && M="$p" && break; done; ' +
  'echo "IRORI_MCTL=$M"; command -v rsync >/dev/null 2>&1 && echo "IRORI_RSYNC=yes" || echo "IRORI_RSYNC=no"';

/**
 * The push job script (ADR-0014): probe every destination first — ssh auth,
 * host key, destination modelctl and rsync — and fail in seconds with a
 * classified `IRORI_PREFLIGHT` line per gap instead of modelctl's ambiguous
 * "not installed" after a 163 GiB attempt (remote.py masks any nonzero ssh
 * exit). A clean probe execs modelctl push; any gap prints
 * `IRORI_PUSH_BLOCKED=` and exits 1 so the hub can remediate and re-push.
 */
function pushPreflightScript(opts: {
  modelctlBin: string;
  name: string;
  hosts: string[];
  jobs?: number;
  cacheDir?: string;
  ssh?: string;
}): string {
  const lines: string[] = [
    "set -u",
    `MCTL=${shq(opts.modelctlBin)}`,
    "FAIL=0",
    "ERR=$(mktemp)",
  ];
  for (const host of opts.hosts) {
    lines.push(
      `H=${shq(host)}`,
      `echo "IRORI_PREFLIGHT ($H): probing destination"`,
      `OUT=$(ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes "$H" sh -c ${shq(REMOTE_PROBE)} 2>"$ERR"); RC=$?`,
      'if [ "$RC" -eq 255 ]; then',
      '  case "$(cat "$ERR")" in',
      '    *Permission*denied*|*publickey*)',
      '      echo "IRORI_PREFLIGHT ($H): ssh auth failed — the transfer key is not authorized; the hub wires the pair automatically on the next push (manual: ssh-copy-id $H)" ;;',
      '    *Host*key*verification*)',
      '      echo "IRORI_PREFLIGHT ($H): destination host key not pinned — the hub wires the pair automatically on the next push" ;;',
      '    *Connection*timed*out*|*Could*not*resolve*hostname*|*Connection*refused*|*No*route*to*host*)',
      '      echo "IRORI_PREFLIGHT ($H): unreachable — $(head -n1 "$ERR")" ;;',
      '    *)',
      '      echo "IRORI_PREFLIGHT ($H): ssh failed — $(head -n1 "$ERR")" ;;',
      '  esac',
      '  FAIL=1',
      'elif [ "$RC" -ne 0 ]; then',
      '  echo "IRORI_PREFLIGHT ($H): probe failed (rc=$RC) — $(head -n1 "$ERR")"',
      '  FAIL=1',
      'else',
      '  M="$(printf "%s\\n" "$OUT" | sed -n "s/^IRORI_MCTL=//p")"',
      '  R="$(printf "%s\\n" "$OUT" | sed -n "s/^IRORI_RSYNC=//p")"',
      '  if [ -z "$M" ]; then',
      '    echo "IRORI_PREFLIGHT ($H): destination modelctl missing — provisioned automatically after the node next reads its inventory (ADR-0013)"',
      '    FAIL=1',
      '  elif [ "$R" != "yes" ]; then',
      '    echo "IRORI_PREFLIGHT ($H): destination rsync missing — the hub installs it before the push (ADR-0014)"',
      '    FAIL=1',
      '  else',
      '    echo "IRORI_PREFLIGHT ($H): ok"',
      '  fi',
      'fi',
    );
  }
  lines.push(
    'rm -f "$ERR"',
    'if [ "$FAIL" -ne 0 ]; then',
    '  echo "IRORI_PUSH_BLOCKED=destination not ready — the hub remediates and re-runs the push"',
    '  exit 1',
    'fi',
  );
  const exec = [`exec "$MCTL" push ${shq(opts.name)}`, ...opts.hosts.map((h) => `--host ${shq(h)}`)];
  if (opts.jobs !== undefined) exec.push(`--jobs ${Math.floor(opts.jobs)}`);
  if (opts.cacheDir !== undefined) exec.push(`--cache-dir ${shq(opts.cacheDir)}`);
  if (opts.ssh !== undefined) exec.push(`--ssh ${shq(opts.ssh)}`);
  lines.push(exec.join(" "));
  return lines.join("\n");
}

/**
 * Resolves a transfer user's passwd entry agent-side (the hub never sends
 * paths); null when the job targets the agent's own user.
 */
function resolveTransferUser(user: string, ctx: ModelctlCtx): { home: string; binary: string } | null {
  const ownUser = !user || user === (ctx.agentUser ?? "root");
  return ownUser ? null : ctx.resolveLocalUser?.(user) ?? null;
}

/** Path env for a per-user modelctl child (uv installs to ~/.local/bin). */
function userBinaryPath(binary: string): string {
  return `${dirname(binary)}:/usr/local/bin:/usr/bin:/bin`;
}

/** Wraps a bash script in the cache-user runuser env (the ADR-0011 shape). */
function runuserScript(user: string, resolved: { home: string; binary: string }, script: string): string[] {
  return runuserWrap(user, resolved.home, { PATH: userBinaryPath(resolved.binary) }, ["bash", "-c", script]);
}

/** The cache-user subset of ModelctlCtx the runuser wrap needs — IR-120 lets
 *  ad-hoc call sites (MODEL_PATH resolution) reuse the same shape. */
export type CacheUserCtx = Pick<ModelctlCtx, "cacheUser" | "agentUser" | "resolveLocalUser">;

/**
 * IR-101: transfers must land in the node's cache owner's HF cache — the
 * registration state lives in the invoking user's home, so running as root
 * with --cache-dir pointed at a user path would split state. When the node has
 * a cache user, wrap modelctl in runuser with a scrubbed env (the IRI-028
 * delete-local pattern). Home/binary resolve agent-side; the hub never sends
 * paths. A missing user modelctl fails the build with an actionable error —
 * it must never silently fall back to root's cache. IR-120 extends this to
 * the setup driver's MODEL_PATH resolution.
 */
export function asCacheUser(argv: string[], ctx: CacheUserCtx, kind: string): { argv: string[]; raw?: boolean } {
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
    argv: runuserWrap(user, resolved.home, { PATH: userBinaryPath(resolved.binary) }, [resolved.binary, ...argv]),
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

/** IR-247: the per-user job branches' null-resolution error. A passwd entry
 *  without a per-user modelctl is NOT unknown — it gets the IR-101 actionable
 *  wording (the hub auto-installs modelctl for that user after the next
 *  inventory read); only a failed passwd lookup is genuinely unknown. */
function cacheUserError(kind: string, user: string, ctx: ModelctlCtx): string {
  if ((ctx.resolveCacheHome?.(user) ?? null) !== null) {
    return `${kind}: no modelctl for cache user "${user}" — install it for that user (sudo -u ${user} uv tool install "modelctl") or clear the node's cache user setting; the hub auto-installs it after the next inventory read`;
  }
  return `${kind}: unknown local cache user "${user}"`;
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
      // IR-105: params.user provisions a cache user's own modelctl (runuser,
      // ADR-0011 shape) — the hub auto-dispatches this after an inventory
      // read when that user's reported version is below the pin. The
      // pre-check skips when the current version already satisfies the pin:
      // a stale env pin on the node must never downgrade a newer binary.
      if (!MODELCTL_PIN_RE.test(ctx.pin)) {
        throw new CommandBuildError(`IRORI_MODELCTL_PIN must be semver, got "${ctx.pin}"`);
      }
      const installUser = str("user");
      // The agent's own user (named or implied) runs the plain script; any
      // other cache user is wrapped in runuser and must resolve to a passwd
      // home. IR-251: the install's whole point is a user WITHOUT a modelctl
      // yet — resolve the passwd home only (IRI-045 resolver). resolveLocalUser
      // demands the per-user binary we are about to create, which turned the
      // IR-247 auto-install and the node-page button into a guaranteed
      // "no modelctl for cache user …" failure for exactly the target case.
      const ownUser = installUser === undefined || installUser === (ctx.agentUser ?? "root");
      const installHome = ownUser ? null : ctx.resolveCacheHome?.(installUser) ?? null;
      if (!ownUser && installHome === null) {
        throw new CommandBuildError(
          `modelctl-install: no passwd entry for cache user "${installUser}" — clear the node's cache user setting`,
        );
      }
      const homeBin = installHome === null ? "/root/.local/bin" : `${installHome}/.local/bin`;
      const script = [
        "set -e",
        `export PATH="${homeBin}:$PATH"`,
        "command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh",
        `PIN="${ctx.pin}"`,
        `CURRENT="$(modelctl --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1 || true)"`,
        'if [ -n "$CURRENT" ]; then',
        '  LOWEST="$(printf \'%s\\n\' "$CURRENT" "$PIN" | sort -V | head -n1)"',
        '  if [ "$LOWEST" = "$PIN" ]; then',
        '    echo "modelctl $CURRENT satisfies the $PIN gate — skipping install"',
        '    exit 0',
        '  fi',
        '  echo "modelctl $CURRENT is older than $PIN — upgrading"',
        'fi',
        // IR-207: pin uv's bin dir to the target home — a node-level
        // UV_TOOL_BIN_DIR in the agent env silently redirected a root install
        // into a cache user's bin (DGX-3, 2026-11-11), leaving the gate
        // binary stale.
        `UV_TOOL_BIN_DIR="${homeBin}" uv tool install --force "git+https://github.com/BlasterSystems/modelctl@v$PIN"`,
        `INSTALLED="$(modelctl --version | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"`,
        `[ -n "$INSTALLED" ] || { echo "modelctl --version produced no version"; exit 1; }`,
        `LOWEST="$(printf '%s\\n' "$INSTALLED" "${ctx.pin}" | sort -V | head -n1)"`,
        `[ "$LOWEST" = "${ctx.pin}" ] || { echo "modelctl $INSTALLED is older than required ${ctx.pin}"; exit 1; }`,
        `echo "modelctl $INSTALLED satisfies the ${ctx.pin} gate"`,
      ].join("\n");
      if (installHome === null) return { argv: ["bash", "-c", script], shell: "bash" };
      return { raw: true, argv: runuserWrap(installUser!, installHome, {}, ["bash", "-c", script]) };
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
      // IR-207: per-entry floor (plus each entry's expected size) inside modelctl.
      if ((ctx.minStoreFreeBytes ?? 0) > 0) argv.push("--min-free-bytes", String(Math.floor(ctx.minStoreFreeBytes!)));
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
      // IR-133: an explicit params.user (the orphan Resume dispatch) runs as
      // that cache owner — same per-user rule as register-local, since the
      // registration state lives in the invoking user's home. Without it, the
      // node's configured cache user applies (IR-101).
      const user = str("user");
      if (user === undefined) return asCacheUser(argv, ctx, "sync-local");
      if (user === (ctx.agentUser ?? "root")) return { argv };
      const resolved = ctx.resolveLocalUser?.(user) ?? null;
      if (resolved === null) {
        throw new CommandBuildError(cacheUserError("sync-local", user, ctx));
      }
      return {
        raw: true,
        argv: runuserWrap(user, resolved.home, { PATH: userBinaryPath(resolved.binary) }, [resolved.binary, ...argv]),
      };
    }
    case "download":
    case "install": {
      const name = str("name") ?? str("repository");
      if (!name) throw new CommandBuildError(`${kind} needs name or repository`);
      const argv = ["download", name];
      // IR-207: the same floor the job-start gate checks rides into modelctl
      // itself — the per-file check now covers the whole expected download.
      if ((ctx.minStoreFreeBytes ?? 0) > 0) argv.push("--min-free-bytes", String(Math.floor(ctx.minStoreFreeBytes!)));
      return { argv };
    }
    case "push": {
      const name = str("name") ?? str("repository");
      if (!name) throw new CommandBuildError("push needs name or repository");
      const hosts = Array.isArray(params.hosts) ? params.hosts.filter((h): h is string => typeof h === "string" && h.length > 0) : [];
      if (hosts.length === 0) throw new CommandBuildError("push needs at least one --host");
      // IR-121: 4 parallel rsync streams is the fleet default for node→node
      // pushes — every hub path passes jobs: 4 explicitly; this default also
      // covers API-created pushes. modelctl's own default is 1 stream.
      const jobs = num("jobs") ?? 4;
      const cache = str("cacheDir");
      const ssh = str("ssh");
      // ADR-0014: probe every destination before modelctl touches it — a
      // 163 GiB transfer must not start against an ssh/rsync/modelctl gap,
      // and modelctl masks every ssh failure as "not installed" (remote.py).
      const user = ctx.cacheUser?.trim();
      const ownUser = !user || user === (ctx.agentUser ?? "root");
      const resolved = ownUser ? null : ctx.resolveLocalUser?.(user) ?? null;
      if (!ownUser && resolved === null) {
        throw new CommandBuildError(`push: no modelctl for cache user "${user}" — install it for that user (sudo -u ${user} uv tool install "modelctl") or clear the node's cache user setting`);
      }
      const modelctlBin = resolved === null ? (ctx.modelctlPath ?? "modelctl") : resolved.binary;
      const script = pushPreflightScript({ modelctlBin, name, hosts, jobs, cacheDir: cache, ssh });
      if (resolved === null) return { argv: ["bash", "-c", script], shell: "bash" };
      return { raw: true, argv: runuserScript(user!, resolved, script) };
    }
    case "ensure-rsync": {
      // ADR-0014: the push destination needs rsync. Narrow + idempotent by
      // design — present is a no-op, apt only, and there are deliberately no
      // params: a package list would make this an arbitrary-install surface.
      const script = [
        'if command -v rsync >/dev/null 2>&1; then',
        '  echo "rsync present: $(rsync --version 2>/dev/null | head -n1)"',
        '  exit 0',
        'fi',
        'if ! command -v apt-get >/dev/null 2>&1; then',
        '  echo "no apt-get — install rsync manually"; exit 1',
        'fi',
        'apt-get update -qq',
        'DEBIAN_FRONTEND=noninteractive apt-get install -y rsync',
        'echo "rsync installed: $(rsync --version 2>/dev/null | head -n1)"',
      ].join("\n");
      return { argv: ["bash", "-c", script], shell: "bash" };
    }
    case "transfer-key-ensure": {
      // ADR-0014: the source cache user needs an ed25519 transfer key; the
      // private key is generated on and stays on this node. Idempotent — an
      // existing key is reused and its public half reported for authorize.
      const user = str("user");
      if (!user) throw new CommandBuildError("transfer-key-ensure needs user");
      const resolved = resolveTransferUser(user, ctx);
      const script = [
        "set -e",
        'mkdir -p "$HOME/.ssh"',
        'chmod 700 "$HOME/.ssh"',
        'if [ ! -f "$HOME/.ssh/id_ed25519" ]; then',
        '  ssh-keygen -t ed25519 -N "" -C "irori-transfer" -f "$HOME/.ssh/id_ed25519" >/dev/null',
        '  echo "generated transfer key"',
        'fi',
        'echo "IRORI_TRANSFER_PUBKEY=$(cat "$HOME/.ssh/id_ed25519.pub")"',
      ].join("\n");
      return resolved === null
        ? { argv: ["bash", "-c", script], shell: "bash" }
        : { raw: true, argv: runuserScript(user, resolved, script) };
    }
    case "transfer-key-authorize": {
      // ADR-0014: append the source's public key to the destination cache
      // user's authorized_keys (deduplicated; the key comment tags it
      // `irori-transfer`) and report this machine's ssh host public keys.
      const user = str("user");
      if (!user) throw new CommandBuildError("transfer-key-authorize needs user");
      const publicKey = str("publicKey");
      if (!publicKey || !/^(ssh|ecdsa)-[a-z0-9@.-]+ [A-Za-z0-9+/=]+/.test(publicKey)) {
        throw new CommandBuildError("transfer-key-authorize needs a valid publicKey");
      }
      const resolved = resolveTransferUser(user, ctx);
      const script = [
        "set -e",
        'mkdir -p "$HOME/.ssh"',
        'chmod 700 "$HOME/.ssh"',
        'touch "$HOME/.ssh/authorized_keys"',
        'chmod 600 "$HOME/.ssh/authorized_keys"',
        `grep -qF ${shq(publicKey)} "$HOME/.ssh/authorized_keys" || echo ${shq(publicKey)} >> "$HOME/.ssh/authorized_keys"`,
        'echo "transfer key authorized"',
        'for f in /etc/ssh/ssh_host_*_key.pub; do [ -f "$f" ] && echo "IRORI_HOSTKEY=$(cat "$f")" || true; done',
      ].join("\n");
      return resolved === null
        ? { argv: ["bash", "-c", script], shell: "bash" }
        : { raw: true, argv: runuserScript(user, resolved, script) };
    }
    case "transfer-hostkey-pin": {
      // ADR-0014: pin the destination's real host keys (relayed by the hub)
      // into the source cache user's known_hosts — idempotent, and
      // ssh-keygen -R clears stale pins after a reimage.
      const user = str("user");
      if (!user) throw new CommandBuildError("transfer-hostkey-pin needs user");
      const host = str("host");
      if (!host) throw new CommandBuildError("transfer-hostkey-pin needs host");
      const hostKeys = Array.isArray(params.hostKeys)
        ? params.hostKeys.filter((k): k is string => typeof k === "string" && /^[^\s]+\s+(ssh|ecdsa)-\S+\s+[A-Za-z0-9+/=]+/.test(k.trim()))
        : [];
      if (hostKeys.length === 0) throw new CommandBuildError("transfer-hostkey-pin needs at least one host key");
      const resolved = resolveTransferUser(user, ctx);
      const script = [
        "set -e",
        'mkdir -p "$HOME/.ssh"',
        'chmod 700 "$HOME/.ssh"',
        'touch "$HOME/.ssh/known_hosts"',
        'chmod 600 "$HOME/.ssh/known_hosts"',
        `ssh-keygen -R ${shq(host)} >/dev/null 2>&1 || true`,
        ...hostKeys.map((k) => `echo ${shq(k.trim())} >> "$HOME/.ssh/known_hosts"`),
        `echo ${shq(`host keys pinned for ${host}`)}`,
      ].join("\n");
      return resolved === null
        ? { argv: ["bash", "-c", script], shell: "bash" }
        : { raw: true, argv: runuserScript(user, resolved, script) };
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
        throw new CommandBuildError(cacheUserError("delete-local", user, ctx));
      }
      return {
        raw: true,
        argv: runuserWrap(user, resolved.home, { PATH: userBinaryPath(resolved.binary) }, [
          resolved.binary,
          "delete-local",
          name,
        ]),
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
        throw new CommandBuildError(cacheUserError("register-local", user, ctx));
      }
      return {
        raw: true,
        argv: runuserWrap(user, resolved.home, { PATH: userBinaryPath(resolved.binary) }, [resolved.binary, ...core]),
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
): { done: Promise<RunOutcome>; pid?: number; cancel: () => void } {
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
    // IR-131: the detached group leader's pid — the negative of it is the pgid
    // the persisted active-job registry uses to kill orphans after a crash.
    pid: child.pid,
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
