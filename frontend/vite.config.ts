import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Stamps a unique build id into the emitted service worker so its cache name
 * changes on every build, letting the SW's `activate` handler purge stale
 * caches (old hashed bundles) instead of accumulating them forever.
 */
function swVersionPlugin(): Plugin {
  return {
    name: "sw-version",
    apply: "build",
    closeBundle() {
      const swPath = resolve(__dirname, "dist/sw.js");
      if (!existsSync(swPath)) return;
      const version = Date.now().toString(36);
      const content = readFileSync(swPath, "utf-8").replaceAll(
        "__BUILD_VERSION__",
        version
      );
      writeFileSync(swPath, content);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), swVersionPlugin()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
