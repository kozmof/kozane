import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { fileURLToPath } from "url";

// @libsql/client exports its browser entry under the "browser" condition, which
// doesn't support in-memory SQLite. Force the Node/SQLite entry so :memory: DBs
// work correctly in tests even though we set conditions: ["browser"] for Svelte.
const libsqlNodeEntry = fileURLToPath(
  new URL("./node_modules/@libsql/client/lib-esm/node.js", import.meta.url),
);

export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: { runes: true },
    }),
  ],
  resolve: {
    conditions: ["browser"],
    alias: {
      $lib: path.resolve("./src/lib"),
      // Mirrors `kit.alias` in svelte.config.js. Both are for `src/routes` only; see the
      // note there on why the tsc-built directories keep relative specifiers.
      $db: path.resolve("./src/db"),
      "styled-system": path.resolve("./styled-system"),
      "@libsql/client": libsqlNodeEntry,
      // SvelteKit virtual modules — only real in a Vite/SvelteKit build.
      "$app/paths": path.resolve("./src/test-utils/app-paths.ts"),
      "$app/navigation": path.resolve("./src/test-utils/app-navigation.ts"),
      "$app/environment": path.resolve("./src/test-utils/app-environment.ts"),
      "$app/state": path.resolve("./src/test-utils/app-state.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-utils/setup.ts"],
    environment: "jsdom",
    maxWorkers: 4,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,svelte}"],
      exclude: [
        // Test infrastructure
        "src/test-utils/**",
        "src/app.d.ts",
        // CLI entry/commands are exercised through subprocess and installed-package smoke tests.
        "src/cli/index.ts",
        "src/cli/commands/**",
        // Filesystem discovery/configuration require isolated CLI integration coverage.
        "src/cli/lib/config.ts",
        "src/cli/lib/project.ts",
        "src/cli/lib/taskspace-scan.ts",
        // Command scaffolding: finds the workspace, opens its database, and exits the
        // process on failure. Exercised by every subprocess test in src/cli/*.e2e.test.ts,
        // none of which can be measured from this process.
        "src/cli/lib/workspace-command.ts",
        // DB plumbing — no logic to assert
        "src/db/internal/**",
        "src/db/client.ts",
        "src/db/schema.ts",
        // SvelteKit wiring — no logic to assert
        "src/lib/index.ts",
        // Page load functions and Svelte components require integration/e2e testing
        "src/routes/**/*page.server.ts",
        "src/routes/**/*.svelte",
      ],
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
      },
    },
  },
});
