import { defineConfig } from "vite";
import { resolve } from "node:path";

// Only index.html, legacy-export.html, src/ and public/ are bundled into dist/. Server code, migrations,
// scripts, docs and environment files are never part of the published site.
export default defineConfig({
  build: {
    outDir: "dist",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), legacyExport: resolve(import.meta.dirname, "legacy-export.html") } },
  },
});
