import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { fileURLToPath } from "url";

// Use libsql's Node entry for in-memory SQLite tests. The browser condition is needed for
// Svelte but would select libsql's browser client.
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
      // Mirror the route aliases from `svelte.config.js` .
      $db: path.resolve("./src/db"),
      "styled-system": path.resolve("./styled-system"),
      "@libsql/client": libsqlNodeEntry,
      // Stub the virtual modules supplied by SvelteKit builds.
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
    // Limit each test's runtime. This does not bound the whole run. Redirect output to a file
    // before filtering it so a consumer that exits early cannot leave the runner running
    // unattended.
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,svelte}"],
      // Coverage thresholds apply only to files outside the exclusions below.
      //
      // - Svelte components have component and browser tests, but this V8 setup does not
      // attribute their compiled coverage to the source files.
      // - CLI commands run in subprocess tests. This process's coverage does not measure their
      // execution.
      exclude: [
        // Test infrastructure
        "src/test-utils/**",
        "src/app.d.ts",
        // CLI subprocess coverage is not collected by this process.
        "src/cli/index.ts",
        "src/cli/commands/**",
        // `spec.test.ts` checks the command tree. Action handlers run in CLI subprocess tests.
        "src/cli/program.ts",
        // Filesystem discovery/configuration require isolated CLI integration coverage.
        "src/cli/lib/config.ts",
        "src/cli/lib/workspace.ts",
        "src/cli/lib/taskspace-scan.ts",
        // Workspace setup and failure exits are exercised by CLI subprocess tests.
        "src/cli/lib/workspace-command.ts",
        // Database setup and schema declarations.
        "src/db/internal/**",
        "src/db/client.ts",
        "src/db/schema.ts",
        // SvelteKit module wiring.
        "src/lib/index.ts",
        // Exclude both page and layout server modules, which require integration coverage.
        "src/routes/**/*page.server.ts",
        "src/routes/**/*layout.server.ts",
        // Exclude route and shared Svelte components because this V8 setup does not measure
        // their source coverage.
        "src/**/*.svelte",
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
