# Combined image: SPA + Bun API in one container, plus a dev-server stage for
# the `web` Compose service.
#
# Stage 1a: install web deps and stage the source. Shared by both web-build
# (production SPA bundle) and web-dev (Vite dev server). Doing this once keeps
# the `npm ci` cache hot for both targets.
FROM node:22-alpine AS web-deps
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Stage 1b: production SPA bundle. Output at /web/dist is consumed by `runtime`.
FROM web-deps AS web-build
RUN npm run build

# Stage 1c: Vite dev server with the source baked in. Used by the `web`
# Compose service so it works on remote hosts (Coolify, etc.) where the
# repo isn't bind-mounted into the container. No HMR against your laptop's
# files — that's a deliberate trade-off for portability; for live HMR run
# `npm run dev` natively on the host.
FROM web-deps AS web-dev
ENV CHOKIDAR_USEPOLLING=true
EXPOSE 8080
CMD ["npm", "run", "dev", "--", "--host"]

# Stage 2: server runtime with bun. We copy the built SPA into ./public and
# the server reads it at request time.
FROM oven/bun:1.1 AS runtime
WORKDIR /app

COPY server/package.json ./package.json
RUN bun install

COPY server/. .
COPY --from=web-build /web/dist ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV PUBLIC_DIR=/app/public
EXPOSE 3000

# `index.ts` runs migrations against $DATABASE_URL on boot before listening.
CMD ["bun", "src/index.ts"]
