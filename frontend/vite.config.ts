import { defineConfig } from "vite";

// No UI framework — plain Vite + TypeScript SPA.
export default defineConfig({
  root: ".",
  publicDir: "public",
  server: {
    port: 5173,
    // Proxy /api to the FastAPI backend during local dev so the SPA can be
    // served same-origin. The API base URL is still configurable at runtime.
    proxy: {
      "/api": {
        target: process.env.DOPAMINE_API_BASE || "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2020",
    outDir: "dist",
    sourcemap: true,
  },
});
