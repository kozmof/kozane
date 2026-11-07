import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: ["restoration.spec.ts", "suspension.spec.ts", "corpus.spec.ts"],
  workers: 1,
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
    // Playwright disables BFCache by default. This harness requires real history restoration.
    launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] },
  },
  webServer: {
    command: "node scripts/restoration-harness/serve.mjs",
    cwd: process.cwd(),
    url: "http://127.0.0.1:4181",
  },
});
