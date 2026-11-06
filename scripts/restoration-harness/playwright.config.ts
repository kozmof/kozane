import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: ["restoration.spec.ts", "suspension.spec.ts"],
  workers: 1,
  use: { browserName: "chromium", trace: "retain-on-failure" },
  webServer: {
    command: "node scripts/restoration-harness/serve.mjs",
    cwd: process.cwd(),
    url: "http://127.0.0.1:4181",
  },
});
