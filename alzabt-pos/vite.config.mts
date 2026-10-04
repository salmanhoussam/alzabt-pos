import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Renderer only. Built to dist/renderer and loaded by Electron from file:// (no dev server, no network).
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: true,
  },
});
