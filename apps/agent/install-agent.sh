#!/usr/bin/env bash
# Irori agent installer (M7, SPEC §11): bundle + config + root systemd unit.
# Usage (as root, on the agent host):
#   ./install-agent.sh --server ws://IRORI_HOST:3947/agent-ws --token irn_... [--version v0.2.0]
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

# The bundle targets node24 and bundles undici 7, which needs the File global
# (Node 20+). Without this check the unit crash-loops for 60 s and the script
# blames the handshake instead of the runtime.
NODE_BIN="$(command -v node || true)"
NODE_VERSION="$([[ -n "$NODE_BIN" ]] && "$NODE_BIN" --version 2>/dev/null || true)"
if [[ -z "$NODE_VERSION" ]] || ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=18)?0:1)' 2>/dev/null; then
  echo "[irori] ${NODE_VERSION:-node not found on PATH} — the agent bundle requires Node.js >= 20.18.1 (undici 7 needs the File global)" >&2
  echo "        install Node 24 and re-run — e.g. curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  exit 2
fi

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

systemctl daemon-reload
systemctl enable --now irori-agent.service

echo "[irori] waiting for the WS hello (up to 60 s)…"
for i in $(seq 1 30); do
  if journalctl -u irori-agent.service --since "-2 min" 2>/dev/null | grep -q "handshake ok"; then
    echo "[irori] agent installed and connected."
    exit 0
  fi
  sleep 2
done

echo "[irori] agent did not report 'handshake ok' within 60 s — check:" >&2
echo "        journalctl -u irori-agent.service -n 50" >&2
exit 1
