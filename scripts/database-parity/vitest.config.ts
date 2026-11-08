import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { resolve } from "node:path";

const browser = process.env.KOZANE_DB_BROWSER === "1";
export default defineConfig({
  plugins: [
    {
      name: "wasm-database-test-fixture",
      enforce: "pre",
      resolveId(source) {
        if (source === "./driver.js")
          return resolve(`scripts/database-parity/${browser ? "browser" : "node"}-db.ts`);
        if (/test-utils\/db(?:\.js|\.ts)?$/.test(source))
          return resolve(`scripts/database-parity/${browser ? "browser" : "node"}-db.ts`);
        if (/\/(?:db\/)?tx(?:\.js|\.ts)?$/.test(source))
          return resolve("packages/core/src/database.ts");
      },
    },
  ],
  resolve: {
    alias: [
      ...["index", "database", "schema", "services", "migrations"].map((name) => ({
        find: new RegExp("^@kozane/core" + (name === "index" ? "" : "/" + name) + "$"),
        replacement: resolve(`packages/core/src/${name}.ts`),
      })),
    ],
  },
  test: {
    include: ["packages/kozane/src/db/api/**/*.test.ts", "scripts/database-parity/*.test.ts"],
    environment: "node",
    maxWorkers: 1,
    testTimeout: 30_000,
    ...(browser
      ? {
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" as const }],
            fileParallelism: false,
          },
        }
      : {}),
  },
});
