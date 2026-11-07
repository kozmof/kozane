import { expect, test } from "@playwright/test";

for (const view of ["board", "tags", "map", "editor"] as const) {
  test(`packed Kit ${view} prerenders and hydrates`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) errors.push(message.text());
    });
    const address = `http://127.0.0.1:4182/kit/${view}/`;
    const response = await request.get(address);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain('data-kit-ready="false"');
    expect(html).toContain(
      view === "map" ? "General" : view === "editor" ? "Kit editor 日本語" : "Packed board 日本語",
    );
    if (view === "board") {
      expect(html).toContain("Read-only workspace.");
      expect(html).toContain('aria-busy="false"');
    }
    await page.goto(address);
    const root = page.locator(`[data-kit-view="${view}"]`);
    await expect(root).toHaveAttribute("data-kit-ready", "true");
    if (view === "board") {
      await expect(page.getByLabel("Workspace mode")).toContainText("Read-only workspace.");
      await expect(root.locator("fieldset")).toHaveAttribute("aria-busy", "false");
    }
    if (view === "editor") {
      const sink = page.getByTestId("editor-sink");
      await sink.focus();
      await sink.pressSequentially("X");
      await expect(page.getByTestId("editor-surface")).toContainText("XKit editor 日本語");
      await sink.press("Control+z");
      await expect(page.getByTestId("editor-surface")).not.toContainText("XKit editor");
    } else {
      // A document marker survives only when SvelteKit handles this link without reloading.
      await page.evaluate(() => {
        document.documentElement.dataset.routerProbe = "preserved";
      });
      const destination =
        view === "board"
          ? "/kit/tags/?namespaceId=packed#tag=release"
          : view === "tags"
            ? "/kit/board/?namespaceId=packed&card=card"
            : "/kit/board/?namespaceId=packed";
      await page.locator(`a[href="${destination}"]`).first().click();
      await expect(page).toHaveURL("http://127.0.0.1:4182" + destination);
      await expect(
        page.locator(`[data-kit-view="${view === "board" ? "tags" : "board"}"]`),
      ).toHaveAttribute("data-kit-ready", "true");
      await expect(page.locator("html")).toHaveAttribute("data-router-probe", "preserved");
    }
    expect(errors).toEqual([]);
  });
}
