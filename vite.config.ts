import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Tauri-compatible Vite config:
// - fixed dev server port so the Tauri shell can rely on a stable URL
// - ignores src-tauri and sidecar in the file watcher (owned by other build pipelines)
// - env vars must be prefixed VITE_ to be exposed to the client (see VITE_SIDECAR_PORT)
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**", "**/sidecar/**"],
    },
  },
  envPrefix: ["VITE_"],
  build: {
    target: "es2021",
    outDir: "dist",
    sourcemap: true,
  },
});
