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
      // What the thresholds below describe, and — just as important — what they do not.
      //
      // Two areas are outside this measurement for reasons that are about the tooling
      // rather than about how well they are tested, so the percentage is not a statement
      // about the whole tree and should not be read as one:
      //
      // - **Svelte components.** v8 reports `0/0` for a `.svelte` file even while its own
      //   test suite renders it and passes — the compiled output carries no mapping this
      //   provider can attribute back to the component. Including them would not lower the
      //   number honestly, it would add zero statements and zero covered statements and
      //   make the figure mean less. They are covered by the component suites beside them
      //   (`KozaneCard.test.ts`, `CardComposer.test.ts`, and six more) and by `e2e/`.
      // - **CLI commands.** Genuinely 0% *in this process*, because every one of them is
      //   exercised by spawning `kozane` as a subprocess — `src/cli/*.e2e.test.ts` — which
      //   v8 cannot instrument from here. Counting them would report code with nine e2e
      //   suites behind it as untested.
      //
      // Everything else is measured, which is what the thresholds hold.
      exclude: [
        // Test infrastructure
        "src/test-utils/**",
        "src/app.d.ts",
        // Exercised by subprocess e2e suites this process cannot measure; see the note above.
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
        // Page load functions require integration/e2e testing
        "src/routes/**/*page.server.ts",
        // Not measurable by v8 rather than not tested; see the note above. Every component,
        // wherever it lives — the ones shared across pages sit in `src/lib/components` and
        // v8 can no more attribute their compiled output than it can a route's.
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
