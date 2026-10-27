# IRI-038 research brief — Push self-healing (preflight, destination deps, transfer keys)

- **Date:** 2026-10-27
- **Ticket:** IRI-038 (epic IR-112, stories IR-113..IR-115)
- **Goal:** A dgx→dgx push must provision or explain its own dependencies: ssh auth between cache users, host key pinning, destination `rsync`, destination `modelctl` — instead of failing with an ambiguous modelctl error after 400 ms. Owner-approved scope (2026-10-27): full self-healing; ADR-0014 records the decision.

All questions are answerable from local sources (`~/Developer/modelctl`, this repo's hub/agent code, live hub job records from the 2026-10-27 failure).

## 1. What actually failed, per the hub's own job records

| Time (2026-10-27) | Job | Outcome |
|---|---|---|
| 18:45:43 | `8659b6dd` push on DGX-1 → `operator@dgx3.lan` | failed, exit 1, 432 ms: "modelctl is not installed on operator@dgx3…" — correct at the time: dgx3 had no modelctl in the probed paths |
| 19:01:53 | `7404d2b9…` models-inventory on DGX-3 (probe) | succeeded → ADR-0013 settle auto-dispatched `modelctl-install` → **installed 0.22.0** (uv cache warm) because DGX-3's pre-IR-106 agent used its stale env pin and ignored the hub's `modelctlPin` config key |
| 19:08:14 | `47b8fc68` agent-update DGX-3 | succeeded → config-update now carries `modelctlPin 0.23.0`; post-update install upgraded operator to **0.23.0** (`/home/operator/.local/bin/modelctl`) |
| 19:09:10 | `80c4f29c` push retry | failed again, exit 1, 404 ms, zero streamed output, same "not installed" — **impossible** if the ssh had reached dgx3, whose binary now existed |
| ~19:15 | owner ran the ssh setup on dgx1 | third push `73c79406` left `queued/running` past 60 s — the transfer started |

Conclusion: the second failure was an **ssh-layer failure masquerading as "modelctl missing"** — see §2.

## 2. modelctl's discovery is ambiguous by construction

`~/Developer/modelctl/src/modelctl/remote.py:227-256`:

```python
script = (
    "cd; for p in "
    + " ".join(_REMOTE_MODELCTL_CANDIDATES)      # "$HOME/.local/bin/modelctl", /usr/local/bin/modelctl, /usr/bin/modelctl
    + "; do [ -x \"$p\" ] && { echo \"$p\"; exit 0; }; done; exit 1"
)
argv = _ssh_argv(ssh, host, port, identity, ["sh", "-c", script])
result = runner(argv, check=False, capture_output=True, text=True, errors="replace")
…
if result.returncode != 0:
    raise ModelctlError(f"modelctl is not installed on {host}; install it with 'uv tool install modelctl' …")
```

Any nonzero returncode — DNS failure, connection refused, `Permission denied (publickey)`, `Host key verification failed` (exit 255), or the genuine probe miss (exit 1) — produces the same "not installed" message. `_ssh_argv` (lines 25-41) shell-quotes each remote argument exactly once, so the script itself is sound; the classification is simply absent. The Irori-side preflight must therefore classify by **returncode + stderr patterns**, not trust modelctl's message:

- ssh exit 255 + `Permission denied` / `publickey` → auth failed (key not authorized)
- ssh exit 255 + `Host key verification failed` → host key not pinned
- ssh exit 255 + `Connection timed out` / `Could not resolve hostname` / `Connection refused` → unreachable
- ssh exit 0, probe reports no modelctl → destination modelctl missing (ADR-0013 auto-dispatch will provision after the destination's next inventory read; the preflight names it)

## 3. Where the push runs and where the hooks are

- The hub builds push stages in `apps/server/src/setups-service.ts:751-755`: `pushStage(source → target (push), …)` with `hosts: [target.cacheUser@target.host]` — the destination is addressed purely as `user@host`, and the comment states the assumption "modelctl ssh user == cache owner" (ADR-0011).
- The source agent builds the job in `apps/agent/src/modelctl.ts` (`buildKindArgs` push case → `asCacheUser` wrapper: `runuser -u <cacheUser> -- env HOME=<home> PATH=<dirname(resolved.binary)>:… <resolved.binary> push <name> --host <host> --jobs N`). `resolved.binary` comes from `resolveLocalUser` (`apps/agent/src/inventory.ts:87+`), which probes the same three candidate paths as modelctl.
- The push job is a single argv/command — the preflight belongs **inside the generated script** (bash probe + classification, then `exec modelctl push …`), so it streams through the existing `job-output` path (persisted: `JobsService.get` returns `output: Array<{seq, line}>`, `apps/server/src/jobs-service.ts:172`).

## 4. Constraints that shape the orchestration

- **One active job per node** (`jobs-service.ts` `ACTIVE = ["queued","running"]`; `create` throws `JobBusyError`). Destination-side provisioning (`ensure-rsync`, `transfer-key-authorize`) must complete before the push job is created on the source, and the orchestrator must tolerate `JobBusyError` with retry/backoff.
- **No hub-held credentials** (ADR-0007; SPEC §3:134 "SSH credentials … never serialized to the API"). The hub relays **public** keys and host public keys only; private keys are generated on and stay on the source node.
- **The hub's job authority already dominates**: agents run server-supplied jobs as root (ADR-0003), so relaying public keys adds no privilege floor — but keys are comment-tagged `irori-transfer` for identification/revocation (ADR-0014 risk note).
- **Agent runs as root** (ADR-0003): it can generate keys into a cache user's `~/.ssh`, append to `authorized_keys`/`known_hosts`, and `apt-get install rsync` — with correct ownership (`chown user:group`) and modes (0600/0644).
- **Host keys**: read from `/etc/ssh/ssh_host_ed25519_key.pub` (+ rsa fallback) on the destination agent; the source pins them into the cache user's `known_hosts` — verified keys via the hub, never `ssh-keyscan` TOFU.
- **Link state**: `transfer_links` (source_node_id, target_node_id, wired_at) — the push stage wires missing links automatically; re-running is idempotent (dedup by `authorized_keys` comment `irori-transfer` + known_hosts line).

## 5. Marker protocol over job output

Job output lines are the only agent→hub data path for jobs (besides snapshots). Provisioning jobs print stable markers the hub parses from the persisted output:

- `IRORI_TRANSFER_PUBKEY=<one-line openssh public key>` (from `transfer-key-ensure`)
- `IRORI_HOSTKEY=<hostname pattern> <type> <base64>` per line (from `transfer-key-authorize`, read from `/etc/ssh/ssh_host_*.pub`)

Both are plain appended lines — no schema change, no new transport; `JobsService.get` already returns the full output array.

## Summary of Findings

1. The 2026-10-27 failure had two independent causes (missing destination modelctl; missing ssh trust), both masked by modelctl's ambiguous "not installed" error — the preflight must classify by ssh returncode/stderr, not by modelctl's message.
2. Hook points: preflight inside the agent's generated push script; `ensure-rsync` + key-exchange jobs orchestrated by the hub's push stage, sequenced before the push because of one-active-per-node.
3. Trust model: public material only through the hub; private keys node-local; `irori-transfer` comment tags for revocation; host keys pinned from the destination's real `/etc/ssh/ssh_host_*.pub` — no TOFU. ADR-0014 records this and supersedes ADR-0011's owner-ops prerequisite.
4. Nothing remains open that blocks implementation; the only external dependency (destination `rsync`) is provisioned by the new `ensure-rsync` job.

## Addendum — 2026-10-27 (post-approval, unchanged evidence)

The owner fixed the DGX-1 → DGX-3 ssh keys manually mid-session; push `73c79406` left the preflight window running (~19:15), confirming §1's conclusion that the ssh layer was the sole remaining gap. The epic still delivers ADR-0014 for every future pair/node.
