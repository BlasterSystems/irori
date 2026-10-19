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
