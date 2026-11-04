import { expect, test } from "@playwright/test";
test("in-memory SQLite proxy works without isolation headers", async ({ page }) => {
  await page.goto("http://127.0.0.1:4179/");
  await expect(page.locator("body")).toHaveText(
    "PASS: proxy transactions, rollback, foreign keys, RETURNING and export",
    { timeout: 30_000 },
  );
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
});
