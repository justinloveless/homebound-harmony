# Server-only image. Useful for local server testing; production uses the
# combined image at the repo root that bundles the built SPA.
FROM oven/bun:1.1 AS deps
WORKDIR /app
COPY package.json ./
RUN bun install

FROM oven/bun:1.1 AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "src/index.ts"]
