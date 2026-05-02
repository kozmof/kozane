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
      "@libsql/client": libsqlNodeEntry,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-utils/setup.ts"],
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,svelte}"],
      exclude: [
        // Test infrastructure
        "src/test-utils/**",
        "src/app.d.ts",
        // CLI — separate process, not unit-testable here
        "src/cli/**",
        // DB plumbing — no logic to assert
        "src/db/internal/**",
        "src/db/client.ts",
        "src/db/schema.ts",
        // SvelteKit wiring — no logic to assert
        "src/hooks.server.ts",
        "src/lib/index.ts",
        // Route handlers and page files need integration/e2e testing
        // SvelteKit names these +server.ts and +page.svelte (leading +, not *.server.ts)
        "src/routes/**/*server.ts",
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
