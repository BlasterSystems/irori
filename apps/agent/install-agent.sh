#!/usr/bin/env bash
# Irori agent installer (M7, SPEC §11): bundle + config + root systemd unit.
# Usage (as root, on the agent host):
#   ./install-agent.sh --server ws://IRORI_HOST:3947/agent-ws --token irn_... [--version v0.2.0]
#   (behind a TLS reverse proxy: --server wss://HUB_DOMAIN/agent-ws)
# Re-running is the fix for a wrong --server/--token: the unit is restarted.
# The script completes successfully only when the agent's WS hello lands
# (verified via the journal).
set -euo pipefail

SERVER=""
TOKEN=""
VERSION="${IRORI_AGENT_VERSION:-latest}"
BUNDLE_URL=""
UNIT_DIR=/etc/systemd/system
ENV_FILE=/etc/irori/agent.env
INSTALL_DIR=/opt/irori
BUNDLE="$INSTALL_DIR/irori-agent.mjs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --bundle-url) BUNDLE_URL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SERVER" ]] || { echo "--server ws://HOST:PORT/agent-ws is required" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "--token irn_... is required (server UI or POST /api/v1/nodes)" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "run as root (the agent is a privileged service)" >&2; exit 2; }

# IRI-156: warn-only preflight. A WebSocket client does not follow redirects,
# so a ws:// URL behind a TLS proxy (301 → https) or a proxy that drops the
# Upgrade header (plain HTTP answer) can never handshake. Probe once and say
# so up front; never block — the hub may simply not be up yet.
preflight_ws() {
  local probe_url code
  case "$SERVER" in
    wss://*) probe_url="https://${SERVER#wss://}" ;;
    ws://*) probe_url="http://${SERVER#ws://}" ;;
    *) echo "[irori] warning: --server should start with ws:// or wss:// (got: $SERVER)" >&2; return 0 ;;
  esac
  # A successful upgrade leaves the socket open, so curl times out (exit 28)
  # after printing 101; only the status code matters here.
  code="$(curl --http1.1 -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: aXJvcmktcHJlZmxpZ2h0IQ==' "$probe_url" 2>/dev/null || true)"
  case "$code" in
    101) echo "[irori] preflight: $SERVER accepts WebSocket upgrades" ;;
    301 | 302 | 307 | 308)
      echo "[irori] warning: $SERVER answered HTTP $code (redirect) — WebSocket clients do not follow redirects." >&2
      [[ "$SERVER" == ws://* ]] && echo "        Behind a TLS proxy use: --server wss://${SERVER#ws://}" >&2 ;;
    000 | "") echo "[irori] warning: could not reach $probe_url — the agent will keep retrying." >&2 ;;
    *) echo "[irori] warning: $SERVER answered HTTP $code instead of 101 — a reverse proxy is likely not forwarding WebSocket upgrades (enable WebSocket support for /agent-ws)." >&2 ;;
  esac
  return 0 # warn-only: never trip `set -e`
}
preflight_ws

# The bundle targets node24 (undici 7 needs the File global). Use the host's
# node when it is node24+; otherwise provision a pinned Node 24 under
# /opt/irori/node so the node needs no system packages. The unit's ExecStart
# and PATH are pointed at the chosen binary further down.
NODE_BIN="$(command -v node || true)"
NODE_MAJOR=0
if [[ -n "$NODE_BIN" ]]; then
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  NODE_DIST="${IRORI_NODE_VERSION:-v24.22.0}"
  case "$(uname -m)" in
    x86_64 | amd64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    *) echo "[irori] unsupported architecture: $(uname -m)" >&2; exit 2 ;;
  esac
  NODE_DIR="${IRORI_NODE_DIR:-/opt/irori/node}"
  if [[ "$("$NODE_DIR/bin/node" -p 'process.versions.node' 2>/dev/null || true)" != "${NODE_DIST#v}" ]]; then
    TARBALL="node-$NODE_DIST-linux-$NODE_ARCH.tar.xz"
    echo "[irori] host node ${NODE_BIN:+at $NODE_BIN }is not node24+ — provisioning $NODE_DIST ($NODE_ARCH) into $NODE_DIR"
    curl -fLsS "https://nodejs.org/dist/$NODE_DIST/$TARBALL" -o "/tmp/$TARBALL"
    curl -fLsS "https://nodejs.org/dist/$NODE_DIST/SHASUMS256.txt" -o /tmp/irori-node-SHASUMS256.txt
    (cd /tmp && grep " $TARBALL\$" irori-node-SHASUMS256.txt | sha256sum -c -)
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xJf "/tmp/$TARBALL" -C "$NODE_DIR" --strip-components=1
    rm -f "/tmp/$TARBALL" /tmp/irori-node-SHASUMS256.txt
  fi
  NODE_BIN="$NODE_DIR/bin/node"
fi
echo "[irori] node: $("$NODE_BIN" --version) ($NODE_BIN)"

if [[ -z "$BUNDLE_URL" ]]; then
  if [[ "$VERSION" == "latest" ]]; then
    BUNDLE_URL="https://github.com/BlasterSystems/irori/releases/latest/download/irori-agent.mjs"
  else
    BUNDLE_URL="https://github.com/BlasterSystems/irori/releases/download/$VERSION/irori-agent.mjs"
  fi
fi

echo "[irori] bundle: $BUNDLE_URL"
mkdir -p "$INSTALL_DIR" /etc/irori
curl -fLsS "$BUNDLE_URL" -o "$BUNDLE.tmp"
mv "$BUNDLE.tmp" "$BUNDLE"

umask 077
cat > "$ENV_FILE" <<EOF
IRORI_SERVER_URL=$SERVER
IRORI_NODE_TOKEN=$TOKEN
EOF
umask 022

UNIT_SRC="$(dirname "$(readlink -f "$0")")/irori-agent.service"
if [[ -f "$UNIT_SRC" ]]; then
  cp "$UNIT_SRC" "$UNIT_DIR/irori-agent.service"
else
  echo "[irori] irori-agent.service not next to the script — expecting it installed already" >&2
fi

# Pin the unit to the chosen runtime and put it first on the service PATH so
# child processes (e.g. the agent-update job's `node --check`) use the same one.
if [[ -f "$UNIT_DIR/irori-agent.service" ]]; then
  sed -i "s|^ExecStart=.*|ExecStart=$NODE_BIN $BUNDLE|" "$UNIT_DIR/irori-agent.service"
  sed -i "/^Environment=PATH=/d" "$UNIT_DIR/irori-agent.service"
  sed -i "/^EnvironmentFile=/a Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "$UNIT_DIR/irori-agent.service"
fi

systemctl daemon-reload
# IRI-156: `enable --now` is a no-op on a running unit, so a re-run with a
# corrected --server/--token/bundle never took effect. Always restart, and only
# trust journal lines written after this point (a stale 'handshake ok' from an
# earlier run must not count as success).
# The journal cursor of the newest entry (any unit) marks an exact, DST-proof
# position; the second-precision timestamp is the fallback when none is shown.
START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
START_CURSOR="$(journalctl -n 1 --show-cursor -q -o cat 2>/dev/null | sed -n 's/^-- cursor: //p' || true)"
agent_log() {
  if [[ -n "$START_CURSOR" ]]; then
    journalctl -u irori-agent.service --after-cursor "$START_CURSOR" -o cat 2>/dev/null || true
  else
    journalctl -u irori-agent.service --since "$START_TS" -o cat 2>/dev/null || true
  fi
}
systemctl enable irori-agent.service
systemctl restart irori-agent.service

echo "[irori] waiting for the WS hello (up to 60 s)…"
for _ in $(seq 1 30); do
  # Capture first, then match: `journalctl | grep -q` can SIGPIPE journalctl
  # and fail the pipeline under pipefail even though the line matched.
  if grep -q "handshake ok" <<<"$(agent_log)"; then
    echo "[irori] agent installed and connected."
    exit 0
  fi
  sleep 2
done

echo "[irori] agent did not report 'handshake ok' within 60 s." >&2
# The agent logs pino JSON: pull out "msg", collapse the per-retry repeats.
LAST_ERRORS="$(agent_log \
  | grep -E "connection error|server error" \
  | sed -E 's/.*"msg":"([^"]*)".*/\1/' | uniq | tail -n 3 || true)"
if [[ -n "$LAST_ERRORS" ]]; then
  echo "[irori] last agent errors:" >&2
  sed 's/^/        /' <<<"$LAST_ERRORS" >&2
fi
echo "[irori] full log: journalctl -u irori-agent.service -n 50" >&2
exit 1
