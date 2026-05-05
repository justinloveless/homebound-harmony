import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// When running the SPA from `docker compose` against the bun API container,
// VITE_API_PROXY_TARGET is set to http://app:3000 so /api/*, /healthz, and
// /s/:id/data are forwarded. Outside Docker (plain `npm run dev`) it's
// unset and the dev server stays self-contained — set it locally if you
// want to point at a remote API.
const apiTarget = process.env.VITE_API_PROXY_TARGET;

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    proxy: apiTarget
      ? {
          "/api":     { target: apiTarget, changeOrigin: false, secure: false, ws: true },
          "/healthz": { target: apiTarget, changeOrigin: false, secure: false },
          // Only /s/:id/data is a server endpoint — /s/:id itself is a SPA
          // route that Vite must keep serving the index.html for.
          "^/s/[^/]+/data$": { target: apiTarget, changeOrigin: false, secure: false },
        }
      : undefined,
    // Bind-mounted FS on Windows/macOS hosts often misses native fsevents,
    // so polling is the safe default inside the dev container.
    watch: process.env.CHOKIDAR_USEPOLLING
      ? { usePolling: true, interval: 300 }
      : undefined,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
