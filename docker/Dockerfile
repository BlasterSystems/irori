# Role images (SPEC §2): the server runs from the `server` target, the agent
# from the `agent` target — separate images, no argv dispatching.
# Build:  docker build --target server -t irori . | docker build --target agent -t irori-agent .

# --- build stage -----------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/proxy/package.json packages/proxy/
COPY apps/server/package.json apps/server/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @irori/core --filter @irori/db --filter @irori/proxy --filter @irori/server --filter @irori/agent --filter @irori/web build

# --- server role -----------------------------------------------------------
FROM node:24-alpine AS server
ENV NODE_ENV=production
ENV IRORI_STATIC_DIR=/srv/irori-web
# Git tag the image was built from — surfaced by /api/v1/version and the UI
# footer. CD (dev-*) and Release (v*) pass it; local builds leave it empty.
ARG GIT_TAG=""
ENV IRORI_GIT_TAG=$GIT_TAG
WORKDIR /app
# Deploy resolves workspace:* into real prod deps for @irori/server.
RUN corepack enable
COPY --from=build /src /build
RUN cd /build && pnpm --filter @irori/server deploy --prod --legacy /app
# Boot migrations read the SQL folder at runtime — ship it.
COPY --from=build /src/packages/db/drizzle /app/packages/db/drizzle
# SPA bundle served by the server (IRORI_STATIC_DIR).
COPY --from=build /src/apps/web/dist /srv/irori-web
# IRI-011 (ADR-0007): agent artifacts served to nodes (installer + unit + bundle).
ENV IRORI_AGENT_ARTIFACTS_DIR=/app/agent-artifacts
COPY --from=build /src/apps/agent/install-agent.sh /app/agent-artifacts/install-agent.sh
COPY --from=build /src/apps/agent/irori-agent.service /app/agent-artifacts/irori-agent.service
COPY --from=build /src/apps/agent/dist/irori-agent.mjs /app/agent-artifacts/irori-agent.mjs
EXPOSE 3947
CMD ["node", "dist/index.js"]

# --- agent role (container agent; bare-metal systemd install is primary) ---
# Debian (not alpine) + rsync/curl: model ops jobs (sync-local, push) need
# rsync; the modelctl-install job needs curl for the uv installer.
FROM node:24-slim AS agent
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends rsync curl ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/apps/agent/dist/irori-agent.mjs /opt/irori/irori-agent.mjs
CMD ["node", "/opt/irori/irori-agent.mjs"]
