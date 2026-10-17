# One image, two roles (SPEC §2): server + agent.
# Build:  docker build -t irori .
# Run:    docker run irori server | docker run irori agent

# --- build stage -----------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/server/package.json apps/server/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @irori/core --filter @irori/db --filter @irori/server --filter @irori/agent --filter @irori/web build

# --- server role -----------------------------------------------------------
FROM node:24-alpine AS server
ENV NODE_ENV=production
ENV IRORI_STATIC_DIR=/srv/irori-web
WORKDIR /app
# Deploy resolves workspace:* into real prod deps for @irori/server.
RUN corepack enable
COPY --from=build /src /build
RUN cd /build && pnpm --filter @irori/server deploy --prod --legacy /app
# Boot migrations read the SQL folder at runtime — ship it.
COPY --from=build /src/packages/db/drizzle /app/packages/db/drizzle
# SPA bundle served by the server (IRORI_STATIC_DIR).
COPY --from=build /src/apps/web/dist /srv/irori-web
EXPOSE 3947
CMD ["node", "dist/index.js"]

# --- agent role (container agent; bare-metal systemd install is primary) ---
FROM node:24-alpine AS agent
ENV NODE_ENV=production
COPY --from=build /src/apps/agent/dist/irori-agent.mjs /opt/irori/irori-agent.mjs
CMD ["node", "/opt/irori/irori-agent.mjs"]
