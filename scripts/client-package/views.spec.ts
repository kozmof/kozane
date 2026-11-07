import { expect, test } from "@playwright/test";

for (const view of ["board", "tags", "map"] as const) {
  test(`packed ${view} SSR hydrates and follows supplied navigation`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) errors.push(message.text());
    });
    const address = `http://127.0.0.1:4182/${view}.html`;
    const response = await request.get(address);
    expect(response.ok()).toBe(true);
    // Confirm meaningful HTML exists before running client JavaScript.
    expect(await response.text()).toContain(view === "map" ? "General" : "Packed board 日本語");
    await page.goto(address);
    await expect(page.locator("body")).toHaveAttribute("data-packaged-client", "ready");
    if (view === "board") {
      await expect(
        page.getByRole("button", { name: "Card: Packed board 日本語 :release", exact: true }),
      ).toBeVisible();
    } else if (view === "tags") {
      await expect(page.getByText("Packed board 日本語 :release", { exact: true })).toBeVisible();
    } else {
      await expect(
        page.locator(
          'svg[aria-label="Namespaces and partitions by card count, with the scopes and tags that cross between them"]',
        ),
      ).toBeVisible();
      const zoom = page.getByRole("button", { name: "Zoom in", exact: true });
      await zoom.click();
      await expect(page.getByRole("button", { name: "110%", exact: true })).toBeEnabled();
    }
    const destination =
      view === "board"
        ? "/packed/tags/?namespaceId=packed#tag=release"
        : view === "tags"
          ? "/packed/board/?namespaceId=packed&card=card"
          : "/packed/board/?namespaceId=packed";
    const link = page.locator(`a[href="${destination}"]`).first();
    await expect(link).toBeVisible();
    // The host owns destination handling. Capture the URL without loading an application route.
    await page.route("**/packed/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Host destination</title>Host destination",
      }),
    );
    await link.click();
    await expect(page).toHaveURL("http://127.0.0.1:4182" + destination);
    await expect(page.getByText("Host destination", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("packed editor accepts input and undo after hydration", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) errors.push(message.text());
  });
  await page.goto("http://127.0.0.1:4182");
  await expect(page.locator("body")).toHaveAttribute("data-packaged-client", "ready");
  const sink = page.getByTestId("editor-sink");
  await sink.focus();
  await sink.press("Home");
  await sink.pressSequentially("X");
  await expect(page.getByTestId("editor-surface")).toContainText("XPacked editor 日本語");
  await sink.press("Control+z");
  await expect(page.getByTestId("editor-surface")).toContainText("Packed editor 日本語");
  await expect(page.getByTestId("editor-surface")).not.toContainText("XPacked editor");
  expect(errors).toEqual([]);
});
