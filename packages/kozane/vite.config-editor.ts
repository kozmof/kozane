import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the page `kozane config open` serves. It is a plain Svelte app, not part of the
 * SvelteKit board, because the config server runs on its own without the database. The output
 * lands in `dist/config-editor`, which the CLI serves and the package ships.
 */

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(projectRoot, "src/config-editor"),
  // Relative asset URLs, so the page works whatever path serves it.
  base: "./",
  plugins: [svelte({ configFile: false, compilerOptions: { runes: true } })],
  resolve: {
    alias: { "styled-system": resolve(projectRoot, "styled-system") },
  },
  // Run Panda through the project's PostCSS config, as the board build does.
  css: { postcss: projectRoot },
  build: {
    outDir: resolve(projectRoot, "dist/config-editor"),
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
