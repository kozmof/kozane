import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "database.spec.ts",
  workers: 1,
  use: { browserName: "chromium", trace: "retain-on-failure" },
  webServer: {
    command: "node scripts/browser-spike/serve.mjs",
    cwd: process.cwd(),
    url: "http://127.0.0.1:4179",
  },
});
