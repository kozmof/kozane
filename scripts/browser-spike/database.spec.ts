import { expect, test } from "@playwright/test";
test("in-memory SQLite proxy works without isolation headers", async ({ page }) => {
  await page.goto("http://127.0.0.1:4179/");
  await expect(page.locator("body")).toHaveText(
    "PASS: proxy transactions, rollback, foreign keys, RETURNING and export",
    { timeout: 30_000 },
  );
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
});

for (const asset of ["worker.js", "sqlite3.wasm"]) {
  test(`rejects altered ${asset} bytes`, async ({ page }) => {
    await page.route(`**/${asset}`, async (route) => {
      const response = await route.fetch();
      const bytes = Buffer.from(await response.body());
      bytes[bytes.length - 1] ^= 1;
      await route.fulfill({ response, body: bytes });
    });
    await page.goto("http://127.0.0.1:4179/");
    await expect(page.locator("body")).toContainText("FAIL:", { timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText("PASS:");
  });
}

test("rejects a mismatched worker build identity", async ({ page }) => {
  await page.route("**/manifest.json", async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    await route.fulfill({ response, json: { ...manifest, buildId: "different-build" } });
  });
  await page.goto("http://127.0.0.1:4179/");
  await expect(page.locator("body")).toHaveText("FAIL: Worker build mismatch");
});
