import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: ["styles.spec.ts", "views.spec.ts"],
  workers: 1,
  use: { browserName: "chromium", trace: "retain-on-failure" },
  webServer: {
    command: "node scripts/client-package/serve.mjs",
    cwd: process.cwd(),
    url: "http://127.0.0.1:4182",
  },
});
