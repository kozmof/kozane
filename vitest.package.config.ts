import { defineConfig } from "vitest/config";
/** Installed-artifact tests never inherit source aliases or the Svelte source plugin. */
export default defineConfig({
  test: {
    include: ["tests/packages/**/*.test.ts"],
    environment: "node",
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
