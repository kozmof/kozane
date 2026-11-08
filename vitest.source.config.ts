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
    alias: [
      ...["index", "ui", "board", "tags", "map", "editor", "testing", "host"].map((name) => ({
        find: new RegExp("^@kozane/client" + (name === "index" ? "" : "/" + name) + "$"),
        replacement: path.resolve("./packages/client/src/" + name + ".ts"),
      })),
      {
        find: "@kozane/client/base.css",
        replacement: path.resolve("./packages/client/src/styles/base.css"),
      },
      ...["index", "database", "schema", "services", "migrations"].map((name) => ({
        find: new RegExp("^@kozane/core" + (name === "index" ? "" : "/" + name) + "$"),
        replacement: path.resolve("./packages/core/src/" + name + ".ts"),
      })),
      ...Object.entries({
        $lib: path.resolve("./packages/kozane/src/lib"),
        // Mirror the route aliases from `svelte.config.js`.
        $db: path.resolve("./packages/kozane/src/db"),
        "styled-system": path.resolve("./styled-system"),
        "@libsql/client": libsqlNodeEntry,
        // Stub the virtual modules supplied by SvelteKit builds.
        "$app/paths": path.resolve("./packages/kozane/src/test-utils/app-paths.ts"),
        "$app/navigation": path.resolve("./packages/kozane/src/test-utils/app-navigation.ts"),
        "$app/environment": path.resolve("./packages/kozane/src/test-utils/app-environment.ts"),
        "$app/state": path.resolve("./packages/kozane/src/test-utils/app-state.ts"),
        "$app/forms": path.resolve("./packages/kozane/src/test-utils/app-forms.ts"),
      }).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  test: {
    include: ["packages/kozane/src/**/*.test.ts", "packages/client/tests/**/*.test.ts"],
    setupFiles: ["packages/kozane/src/test-utils/setup.ts"],
    environment: "jsdom",
    maxWorkers: 4,
    // Limit each test's runtime. This does not bound the whole run. Redirect output to a file
    // before filtering it so a consumer that exits early cannot leave the runner running
    // unattended.
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: [
        "packages/kozane/src/**/*.{ts,svelte}",
        "packages/client/src/**/*.{ts,svelte}",
        "packages/core/src/**/*.ts",
      ],
      // Coverage thresholds apply only to files outside the exclusions below.
      //
      // - Svelte components have component and browser tests, but this V8 setup does not
      // attribute their compiled coverage to the source files.
      // - CLI commands run in subprocess tests. This process's coverage does not measure their
      // execution.
      exclude: [
        // Test infrastructure
        "packages/kozane/src/test-utils/**",
        "packages/kozane/src/app.d.ts",
        // CLI subprocess coverage is not collected by this process.
        "packages/kozane/src/cli/index.ts",
        "packages/kozane/src/cli/commands/**",
        // `spec.test.ts` checks the command tree. Action handlers run in CLI subprocess tests.
        "packages/kozane/src/cli/program.ts",
        // Split command registration retains that subprocess-only wiring exclusion.
        // Keep program/parsers.ts measured and directly tested.
        "packages/kozane/src/cli/program/{board,cards,data,structure,workspace}.ts",
        // Filesystem discovery and configuration require isolated CLI integration coverage.
        "packages/kozane/src/cli/lib/config.ts",
        "packages/kozane/src/cli/lib/workspace.ts",
        "packages/kozane/src/cli/lib/taskspace-scan.ts",
        // Workspace setup and failure exits are exercised by CLI subprocess tests.
        "packages/kozane/src/cli/lib/workspace-command.ts",
        // Database setup and schema declarations.
        "packages/kozane/src/db/internal/**",
        "packages/kozane/src/db/client.ts",
        "packages/kozane/src/db/schema.ts",
        "packages/core/src/schema.ts",
        // SvelteKit module wiring.
        "packages/kozane/src/lib/index.ts",
        // Mounts the config page in the browser. `App.test.ts` renders the app itself.
        "packages/kozane/src/config-editor/main.ts",
        // Exclude both page and layout server modules, which require integration coverage.
        "packages/kozane/src/routes/**/*page.server.ts",
        "packages/kozane/src/routes/**/*layout.server.ts",
        // Exclude route and shared Svelte components because this V8 setup does not measure
        // their source coverage.
        "packages/kozane/src/**/*.svelte",
        "packages/client/src/**/*.svelte",
        "packages/client/src/styles/generated/**",
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
