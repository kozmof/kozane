import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Test the taskspace editor with real browser layout. Caret placement, selections, and pointer
 * coordinates depend on font measurements that jsdom cannot provide. `EditorSurface.test.ts`
 * covers editing behavior separately.
 */

const packageRoot = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "kozane-editor-e2e-"));
const port = String(20_000 + Math.floor(Math.random() * 20_000));
const baseUrl = `http://127.0.0.1:${port}`;
const taskspaceDir = join(workspace, "demo");
let server: ChildProcess | undefined;
let namespaceId = "";

function cli(...args: string[]): string {
  const result = spawnSync(process.execPath, [join(packageRoot, "bin", "kozane.js"), ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    throw new Error(
      `kozane ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout;
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Kozane editor test server did not start");
}

type Page = import("@playwright/test").Page;

/** Opens the board, shows the panels, and opens one file from the taskspace tree. */
async function openFile(page: Page, name: string): Promise<void> {
  await page.goto(`${baseUrl}/${namespaceId}`);
  await page.getByTitle("Show panels").click();
  await page.getByRole("button", { name: "Work" }).click();
  await page.getByRole("button", { name: "demo" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("dialog", { name: new RegExp(`Editing ${name}`) })).toBeVisible();
}

async function openTheFile(page: Page): Promise<void> {
  await openFile(page, "notes.md");
}

/**
 * Measure a column's left edge on the line containing `lineText` with the browser's `Range`
 * API. Real font metrics let these tests check the editor's positioning without assuming a
 * fixed character width.
 */
async function columnX(page: Page, lineText: string, column: number): Promise<number> {
  return page.evaluate(
    ({ lineText, column }) => {
      const el = [...document.querySelectorAll("[data-line]")].find(
        (d) => d.textContent === lineText,
      );
      if (!el?.firstChild) throw new Error(`no line reading ${lineText}`);
      const range = document.createRange();
      range.setStart(el.firstChild, 0);
      range.setEnd(el.firstChild, column);
      const rect = range.getBoundingClientRect();
      return column === 0 ? rect.left : rect.right;
    },
    { lineText, column },
  );
}

/** The vertical middle of the line reading `lineText`. */
async function lineY(page: Page, lineText: string): Promise<number> {
  const box = await page.getByText(lineText, { exact: true }).boundingBox();
  if (!box) throw new Error(`no box for line ${lineText}`);
  return box.y + box.height / 2;
}

/** The middle of the cell `column` occupies, which is where a click on it belongs. */
async function cellCentre(page: Page, lineText: string, column: number): Promise<number> {
  const [left, right] = await Promise.all([
    columnX(page, lineText, column),
    columnX(page, lineText, column + 1),
  ]);
  return (left + right) / 2;
}

test.beforeAll(async () => {
  cli("init");
  const scopeOut = cli("scope", "add", "Work");
  const scopeId = scopeOut.match(/id\s*:\s*(\S+)/)?.[1];
  if (!scopeId) throw new Error(`No scope id in:\n${scopeOut}`);
  cli("taskspace", "create", "demo", "--scope", scopeId);

  mkdirSync(join(taskspaceDir, "src"), { recursive: true });
  writeFileSync(join(taskspaceDir, "notes.md"), "alpha\nbravo\ncharlie\n");
  writeFileSync(join(taskspaceDir, "src", "app.ts"), "export {}\n");
  // Place double-width and single-width cells on the same line to test measured geometry.
  writeFileSync(join(taskspaceDir, "cjk.md"), "あいうabc\nplain\n");
  writeFileSync(join(taskspaceDir, "selectme.md"), "abcdefghij\nsecond\n");
  writeFileSync(join(taskspaceDir, "grouped.md"), "start \n");
  writeFileSync(
    join(taskspaceDir, "long.md"),
    Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n",
  );

  // The marker and routes use full UUIDs. The CLI prints short IDs.
  namespaceId = JSON.parse(readFileSync(join(taskspaceDir, ".taskspace.json"), "utf8"))
    .namespaceId as string;

  server = spawn(process.execPath, [join(packageRoot, "build", "index.js")], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: `file:${join(workspace, ".kozane", "kozane.db")}`,
      KOZANE_WORKSPACE_ROOT: workspace,
      HOST: "127.0.0.1",
      PORT: port,
      ORIGIN: baseUrl,
    },
    stdio: "pipe",
  });
  await waitForServer();
});

test.afterAll(() => {
  if (server && !server.killed) server.kill("SIGTERM");
  rmSync(workspace, { recursive: true, force: true });
});

test("opens a file from the taskspace tree and shows its text", async ({ page }) => {
  await openTheFile(page);
  await expect(page.getByText("alpha")).toBeVisible();
  await expect(page.getByText("bravo")).toBeVisible();
  await expect(page.getByText("Ln 1, Col 1")).toBeVisible();
});

test("types into a file and saves it to disk", async ({ page }) => {
  await openTheFile(page);

  await page.getByTestId("editor-sink").focus();
  await page.keyboard.type("ZZ");
  await expect(page.getByTitle("Unsaved changes")).toBeVisible();

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTitle("Unsaved changes")).toBeHidden();

  expect(readFileSync(join(taskspaceDir, "notes.md"), "utf8")).toBe("ZZalpha\nbravo\ncharlie\n");

  // Reload to verify that the edit was saved to disk.
  await page.reload();
  await openTheFile(page);
  await expect(page.getByText("ZZalpha")).toBeVisible();
});

test("places the caret where the text is clicked", async ({ page }) => {
  await openTheFile(page);

  const charlie = page.getByText("charlie");
  const box = await charlie.boundingBox();
  if (!box) throw new Error("no box for the line");
  // The line box includes horizontal padding. Subtract it when mapping clicks to text columns.
  const padLeft = await charlie.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).paddingLeft),
  );
  const middleY = box.y + box.height / 2;

  // Clicking the first character lands on the first column, not the second.
  await page.mouse.click(box.x + padLeft + 1, middleY);
  await expect(page.getByText("Ln 3, Col 1")).toBeVisible();

  // A click beyond the text stops at column 8, after the seven characters in "charlie". Click
  // halfway across the panel to avoid its scrollbar.
  await page.mouse.click(box.x + box.width / 2, middleY);
  await expect(page.getByText("Ln 3, Col 8")).toBeVisible();

  // The top of a line must map to that line after accounting for vertical padding.
  await page.mouse.click(box.x + padLeft + 1, box.y + 1);
  await expect(page.getByText("Ln 3, Col 1")).toBeVisible();
});

test("takes focus back when the text is clicked after focus went elsewhere", async ({ page }) => {
  await openTheFile(page);
  await page.getByTestId("editor-sink").focus();

  // Move focus out of the editor entirely, the way clicking the panel chrome does.
  await page.getByRole("button", { name: "Close" }).focus();
  await expect(page.getByTestId("editor-cursor")).toBeHidden();

  await page.getByText("bravo").click();
  await expect(page.getByTestId("editor-cursor")).toBeVisible();
  await expect(page.getByTestId("editor-sink")).toBeFocused();

  // Typing verifies that the editor has keyboard focus.
  await page.keyboard.type("X");
  await expect(page.getByTitle("Unsaved changes")).toBeVisible();
});

test("fits the text to the panel rather than overflowing it sideways", async ({ page }) => {
  await openTheFile(page);

  const surface = page.getByTestId("editor-surface");
  const overflow = await surface.evaluate((el) => el.scrollWidth - el.clientWidth);
  // A short file should fit without a horizontal scrollbar. The sizer must include padding
  // within its width.
  expect(overflow).toBe(0);

  // A click anywhere along the line reaches the editor.
  const lineBox = await page.getByText("charlie").boundingBox();
  const surfaceBox = await surface.boundingBox();
  if (!lineBox || !surfaceBox) throw new Error("no box");
  expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(surfaceBox.x + surfaceBox.width + 1);
});

test("puts the caret back at the edit an undo takes back", async ({ page }) => {
  await openTheFile(page);
  await page.getByTestId("editor-sink").focus();

  // Type two characters in one edit, then move the caret to the first line. One undo should
  // remove both characters.
  await page.getByText("charlie").click();
  await page.keyboard.press("End");
  await page.keyboard.type("!!");
  await expect(page.getByText("charlie!!")).toBeVisible();

  await page.keyboard.press("Control+Home");
  await expect(page.getByText("Ln 1, Col 1")).toBeVisible();

  // Undo belongs at the text it restored, not at the caret it was pressed from.
  await page.keyboard.press("Control+z");
  await expect(page.getByText("charlie")).toBeVisible();
  await expect(page.getByText("Ln 3, Col 8")).toBeVisible();

  // Redo lands past the text it put back.
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByText("charlie!!")).toBeVisible();
  await expect(page.getByText("Ln 3, Col 10")).toBeVisible();
});

test("lands a click on the right character in a line of double-width cells", async ({ page }) => {
  await openFile(page, "cjk.md");

  // Use three double-width cells followed by three single-width cells. Browser font metrics
  // verify the geometry modeled by the unit tests.
  const line = "あいうabc";
  const y = (await page.getByText(line).boundingBox())!.y + 10;

  for (const column of [0, 1, 2, 3, 4, 5]) {
    await page.mouse.click(await cellCentre(page, line, column), y);
    await expect(page.getByText(`Ln 1, Col ${column + 1}`)).toBeVisible();
  }

  // Verify that the measured cells have different widths. The exact ratio depends on the
  // available fonts.
  const wide = (await columnX(page, line, 1)) - (await columnX(page, line, 0));
  const narrow = (await columnX(page, line, 4)) - (await columnX(page, line, 3));
  expect(wide).toBeGreaterThan(narrow);
});

test("selects what was dragged over and replaces it", async ({ page }) => {
  await openFile(page, "selectme.md");
  const line = "abcdefghij";
  const y = (await page.getByText(line).boundingBox())!.y + 10;

  // Drag from the start of "c" to the start of "g" to select four characters.
  await page.mouse.move(await columnX(page, line, 2), y);
  await page.mouse.down();
  await page.mouse.move(await columnX(page, line, 6), y, { steps: 8 });
  await page.mouse.up();

  // Verify the selection rectangles as well as the selected text.
  await expect(page.getByTestId("editor-selection")).toHaveCount(1);

  await page.keyboard.press("Backspace");
  await expect(page.getByText("abghij")).toBeVisible();
});

test("groups a run of typing into one undo, and breaks the group after a pause", async ({
  page,
}) => {
  await openFile(page, "grouped.md");
  await page.getByTestId("editor-sink").focus();
  await page.keyboard.press("End");

  await page.keyboard.type("hello");
  await expect(page.getByText("start hello")).toBeVisible();

  // One undo removes the whole typing run. This checks grouping with the real clock.
  await page.keyboard.press("Control+z");
  await expect(page.getByText("start")).toBeVisible();
  await expect(page.getByText("start hello")).toBeHidden();

  // Past the window, so what follows is a new entry rather than more of the last one.
  await page.keyboard.type("one");
  await page.waitForTimeout(600);
  await page.keyboard.type("two");
  await expect(page.getByText("start onetwo")).toBeVisible();

  await page.keyboard.press("Control+z");
  await expect(page.getByText("start one")).toBeVisible();
});

test("draws only the lines in view and scrolls the rest of a long file", async ({ page }) => {
  await openFile(page, "long.md");

  const surface = page.getByTestId("editor-surface");
  await expect(page.getByText("line 0", { exact: true })).toBeVisible();

  // The DOM should contain only the visible portion of the 400-line document.
  const drawn = await surface.evaluate((el) => el.querySelectorAll("[data-line]").length);
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThan(120);

  // The sizer gives the scrollbar the whole document's height to move through.
  const scrollable = await surface.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(scrollable).toBeGreaterThan(1000);

  await surface.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(page.getByText("line 399", { exact: true })).toBeVisible();
  await expect(page.getByText("line 0", { exact: true })).toBeHidden();
});

test("returns the caret to where a backspace was pressed from when it is undone", async ({
  page,
}) => {
  await openFile(page, "selectme.md");

  // Put the caret after "e", backspace it away, then undo.
  const line = "abcdefghij";
  await page.mouse.click(await columnX(page, line, 5), await lineY(page, line));
  await expect(page.getByText("Ln 1, Col 6")).toBeVisible();

  await page.keyboard.press("Backspace");
  await expect(page.getByText("abcdfghij")).toBeVisible();
  await expect(page.getByText("Ln 1, Col 5")).toBeVisible();

  // Undo restores the caret to column 6, where Backspace was pressed.
  await page.keyboard.press("Control+z");
  await expect(page.getByText("abcdefghij")).toBeVisible();
  await expect(page.getByText("Ln 1, Col 6")).toBeVisible();
});

test("resizes by dragging the left edge, and keeps the width across a close", async ({ page }) => {
  await openTheFile(page);

  const panel = page.getByRole("dialog", { name: /Editing/ });
  const before = (await panel.boundingBox())!.width;

  // Drag the edge 150px to the left, which widens the panel by the same.
  const handle = page.getByRole("separator", { name: "Resize editor" });
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x - 150, grip.y + grip.height / 2, { steps: 10 });
  await page.mouse.up();

  const widened = (await panel.boundingBox())!.width;
  expect(widened).toBeGreaterThan(before + 100);

  // The width belongs to the page rather than to the file, so it survives a close.
  await page.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();

  await page.getByRole("button", { name: "notes.md", exact: true }).click();
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())!.width).toBeCloseTo(widened, 0);

  // Reload resets the panel width because it is not persisted.
  await page.reload();
  await openTheFile(page);
  expect((await panel.boundingBox())!.width).toBeCloseTo(before, 0);
});

test("refuses to save over a file that changed on disk, and reloads it", async ({ page }) => {
  await openTheFile(page);
  await page.getByTestId("editor-sink").focus();
  await page.keyboard.type("mine");

  writeFileSync(join(taskspaceDir, "notes.md"), "changed underneath\n");

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/changed on disk/)).toBeVisible();
  expect(readFileSync(join(taskspaceDir, "notes.md"), "utf8")).toBe("changed underneath\n");

  await page.getByRole("button", { name: "Reload from disk" }).click();
  await expect(page.getByText("changed underneath")).toBeVisible();
  await expect(page.getByText(/changed on disk/)).toBeHidden();
});

test("commits an IME composition as one word rather than one character at a time", async ({
  page,
}) => {
  writeFileSync(join(taskspaceDir, "notes.md"), "\n");
  await openTheFile(page);

  const sink = page.getByTestId("editor-sink");
  await sink.focus();

  // Use Playwright's CDP session to simulate IME preedit updates followed by a commit.
  const client = await page.context().newCDPSession(page);
  await client.send("Input.imeSetComposition", {
    text: "にほn",
    selectionStart: 3,
    selectionEnd: 3,
  });
  await expect(page.locator("[data-preedit]")).toHaveText("にほn");

  await client.send("Input.insertText", { text: "日本" });
  await expect(page.locator("[data-preedit]")).toHaveCount(0);
  await expect(page.getByText("日本")).toBeVisible();

  // One undo takes the whole word back, not the last candidate.
  await page.keyboard.press("Control+z");
  await expect(page.getByText("日本")).toBeHidden();
});

test("closes on Escape and on a click outside the panel", async ({ page }) => {
  const panel = page.getByRole("dialog", { name: /Editing/ });

  await openTheFile(page);
  await page.getByTestId("editor-sink").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // Use the board as the click target outside the editor panel.
  await page.getByRole("button", { name: "notes.md", exact: true }).click();
  await expect(panel).toBeVisible();
  await page.mouse.click(80, 300);
  await expect(panel).toBeHidden();
});

test("asks before either route throws unsaved changes away", async ({ page }) => {
  const panel = page.getByRole("dialog", { name: /Editing/ });
  await openFile(page, "grouped.md");

  await page.getByTestId("editor-sink").focus();
  await page.keyboard.type("edited");
  await expect(page.getByTitle("Unsaved changes")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(page.getByText("This file has unsaved changes.")).toBeVisible();

  // Backing out leaves the file open and still edited.
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByText("This file has unsaved changes.")).toBeHidden();
  await expect(page.getByTitle("Unsaved changes")).toBeVisible();

  // A click on the board asks the same question rather than closing.
  await page.mouse.click(80, 300);
  await expect(page.getByText("This file has unsaved changes.")).toBeVisible();
  await expect(panel).toBeVisible();

  await page.getByRole("button", { name: "Discard and close" }).click();
  await expect(panel).toBeHidden();
  // Discarding leaves the file on disk unchanged.
  expect(readFileSync(join(taskspaceDir, "grouped.md"), "utf8")).toBe("start \n");
});

test("leaves a file untouched when it is closed without saving", async ({ page }) => {
  writeFileSync(join(taskspaceDir, "notes.md"), "untouched\n");
  await openTheFile(page);

  await page.getByTestId("editor-sink").focus();
  await page.keyboard.type("dirty");

  // The header Close button also prompts for unsaved changes. The preceding test covers Escape
  // and a click on the board.
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("This file has unsaved changes.")).toBeVisible();
  await page.getByRole("button", { name: "Discard and close" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  expect(readFileSync(join(taskspaceDir, "notes.md"), "utf8")).toBe("untouched\n");
});
