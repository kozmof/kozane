import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The taskspace file editor, in a browser with real layout.
 *
 * This is where the parts the jsdom tests cannot reach are checked: the caret and selection
 * are painted from measured pixels, and a click has to land on the character under it.
 * `EditorSurface.test.ts` covers which keys produce which edits; nothing there can say
 * whether the cursor is drawn in the right place, because jsdom reports every rect as zero.
 */

const packageRoot = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "kozane-editor-e2e-"));
const port = String(20_000 + Math.floor(Math.random() * 20_000));
const baseUrl = `http://127.0.0.1:${port}`;
const taskspaceDir = join(workspace, "demo");
let server: ChildProcess | undefined;
let projectId = "";

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

/** Opens the board, shows the panels, and opens `notes.md` from the taskspace tree. */
async function openTheFile(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${baseUrl}/${projectId}`);
  await page.getByTitle("Show panels").click();
  await page.getByRole("button", { name: "Work" }).click();
  await page.getByRole("button", { name: "demo" }).click();
  await page.getByRole("button", { name: "notes.md" }).click();
  await expect(page.getByRole("dialog", { name: /Editing notes\.md/ })).toBeVisible();
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

  // The marker carries the full UUIDs; the CLI prints short ids, and the routes want the
  // full ones.
  projectId = JSON.parse(readFileSync(join(taskspaceDir, ".taskspace.json"), "utf8"))
    .projectId as string;

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

  // And it is still there after a reload, read back from disk rather than from the tab.
  await page.reload();
  await openTheFile(page);
  await expect(page.getByText("ZZalpha")).toBeVisible();
});

test("places the caret where the text is clicked", async ({ page }) => {
  await openTheFile(page);

  const charlie = page.getByText("charlie");
  const box = await charlie.boundingBox();
  if (!box) throw new Error("no box for the line");
  // The line is drawn with horizontal padding, so its box starts a padding before its
  // text. Counting that padding as part of the text is what put a click about two
  // characters to the right of where it was aimed.
  const padLeft = await charlie.evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).paddingLeft),
  );
  const middleY = box.y + box.height / 2;

  // Clicking the first character lands on the first column, not the second.
  await page.mouse.click(box.x + padLeft + 1, middleY);
  await expect(page.getByText("Ln 3, Col 1")).toBeVisible();

  // Clicking well past the end of the text stops at the end of the line rather than
  // running on into the empty space after it. "charlie" is seven characters, so the
  // caret belongs at column 8. Halfway across the panel rather than at its edge: a line
  // runs the full width of the surface, and its far edge is where the scrollbar sits.
  await page.mouse.click(box.x + box.width / 2, middleY);
  await expect(page.getByText("Ln 3, Col 8")).toBeVisible();

  // And the top of a line belongs to that line: the vertical padding was being counted
  // too, which put the bottom of each line on the line below.
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

  // And it is really focused, not just painted: typing lands in the file.
  await page.keyboard.type("X");
  await expect(page.getByTitle("Unsaved changes")).toBeVisible();
});

test("fits the text to the panel rather than overflowing it sideways", async ({ page }) => {
  await openTheFile(page);

  const surface = page.getByTestId("editor-surface");
  const overflow = await surface.evaluate((el) => el.scrollWidth - el.clientWidth);
  // A short file has nothing to scroll to. The sizer used to add its own padding on top of
  // a 100% width, which put a horizontal scrollbar under every file and pushed each line a
  // padding past the visible edge.
  expect(overflow).toBe(0);

  // And a line ends where the panel does, so a click anywhere along it reaches the editor.
  const lineBox = await page.getByText("charlie").boundingBox();
  const surfaceBox = await surface.boundingBox();
  if (!lineBox || !surfaceBox) throw new Error("no box");
  expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(surfaceBox.x + surfaceBox.width + 1);
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

  // Drive a composition the way an IME does: a preedit that is revised, then a commit.
  // Playwright's CDP session is what makes a real composition reachable at all.
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

test("leaves a file untouched when it is closed without saving", async ({ page }) => {
  writeFileSync(join(taskspaceDir, "notes.md"), "untouched\n");
  await openTheFile(page);

  await page.getByTestId("editor-sink").focus();
  await page.keyboard.type("dirty");
  await page.getByRole("button", { name: "Close" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  expect(readFileSync(join(taskspaceDir, "notes.md"), "utf8")).toBe("untouched\n");
});
