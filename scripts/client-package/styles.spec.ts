import { expect, test } from "@playwright/test";
test("packed stylesheet survives production bundling and styles hydrated views without Panda", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) errors.push(message.text());
  });
  await page.goto("http://127.0.0.1:4182");
  await expect(page.locator("body")).toHaveAttribute("data-packaged-client", "ready");
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  const editor = page.getByTestId("editor-surface");
  await expect(editor).toHaveCSS("position", "relative");
  await expect(editor).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(editor).toHaveCSS("color", "rgb(28, 28, 28)");
  await expect(editor).toHaveCSS("font-size", "12.5px");
  await expect(editor).toHaveCSS("font-family", /IBM Plex Mono/);
  await expect(editor).toHaveCSS("box-sizing", "border-box");
  await expect(page.locator("body")).toHaveCSS("margin", "0px");
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--colors-ink-black").trim(),
    ),
  ).toBe("#1c1c1c");
  await expect(page.locator("#packed-namespaces")).toContainText("Packed workspace");
  await expect(
    page.locator('#packed-namespaces a[href="/packed/board/?namespaceId=packed"]'),
  ).toBeVisible();
  // Later base/recipe rules must not outrank existing utility-layer styles.
  await page.addStyleTag({
    content:
      '@layer base { [data-testid="editor-surface"] { color: rgb(1,2,3) } } @layer recipes { [data-testid="editor-surface"] { background: rgb(4,5,6) } }',
  });
  await expect(editor).toHaveCSS("color", "rgb(28, 28, 28)");
  await expect(editor).toHaveCSS("background-color", "rgb(255, 255, 255)");
  expect(errors).toEqual([]);
});
