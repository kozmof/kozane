import { expect, test } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("http://127.0.0.1:4181");
  await expect(page.locator("body")).toHaveAttribute("data-harness", "ready");
});
test("validates fresh sample bytes under the demo CSP", async ({ page }) => {
  const result = await page.evaluate(async () => (window as any).restorationHarness.run());
  expect(result).toMatchObject({ status: "ready", source: "sample", view: { kind: "selected" } });
});
test("restores matching bytes and preserves an explicit missing namespace", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const harness = (window as any).restorationHarness;
    const bytes = new Uint8Array(await (await fetch("/sample.db")).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    sessionStorage.setItem(
      "kozane-demo:session",
      JSON.stringify({ schemaVersion: harness.schemaVersion, savedAt: 0, db: btoa(binary) }),
    );
    const result = await harness.run("missing-namespace");
    return { result, preserved: sessionStorage.getItem("kozane-demo:session") !== null };
  });
  expect(result).toMatchObject({
    result: { status: "ready", source: "restored", view: { kind: "missing" } },
    preserved: true,
  });
});
test("deletes malformed recovery only after validated sample fallback", async ({ page }) => {
  const result = await page.evaluate(async () => {
    sessionStorage.setItem("kozane-demo:session", "malformed");
    const result = await (window as any).restorationHarness.run();
    return { result, saved: sessionStorage.getItem("kozane-demo:session") };
  });
  expect(result).toMatchObject({
    result: { status: "ready", source: "sample", fallbackReason: "malformed" },
    saved: null,
  });
});
test("preserves rejected recovery when sample asset verification fails", async ({ page }) => {
  await page.route("**/sample.db", (route) =>
    route.fulfill({ body: "invalid asset", contentType: "application/octet-stream" }),
  );
  const result = await page.evaluate(async () => {
    sessionStorage.setItem("kozane-demo:session", "malformed");
    const result = await (window as any).restorationHarness.run();
    return { result, saved: sessionStorage.getItem("kozane-demo:session") };
  });
  expect(result).toMatchObject({
    result: { status: "unavailable", action: "reload", kind: "asset" },
    saved: "malformed",
  });
});
