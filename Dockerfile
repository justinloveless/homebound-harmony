# Combined image: SPA + Bun API in one container.
#
# Stage 1: build the SPA with Node (vite + esbuild work best on the official
# Node images; bun could do it too but Node keeps the build deterministic).
FROM node:22-alpine AS web-build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

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
