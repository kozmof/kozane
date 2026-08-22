import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "kozane-browser-e2e-"));
const port = String(20_000 + Math.floor(Math.random() * 20_000));
const baseUrl = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
let apiKey = "";

function cli(...args: string[]): void {
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
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Kozane browser test server did not start");
}

test.beforeAll(async () => {
  cli("init");
  cli("project", "create", "Browser project");
  cli("api", "key", "generate");
  apiKey = JSON.parse(readFileSync(join(workspace, ".kozane", "api.json"), "utf8")).apiKey;

  server = spawn(process.execPath, [join(packageRoot, "build", "index.js")], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: `file:${join(workspace, ".kozane", "kozane.db")}`,
      KOZANE_WORKSPACE_ROOT: workspace,
      HOST: "127.0.0.1",
      PORT: port,
      // Matches what `kozane open` sets for a loopback binding so SvelteKit's
      // CSRF origin check accepts the login form POST over http.
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

test("authenticates, hydrates, creates, and persists a card", async ({ page }) => {
  await page.goto(`${baseUrl}/?api_key=${encodeURIComponent(apiKey)}`);
  await expect(page).toHaveURL(`${baseUrl}/`);
  await page.getByRole("link", { name: "Browser project" }).click();

  const composer = page.getByLabel("Write a card");
  await expect(composer).toBeFocused();
  await composer.fill("Created in a real browser");
  await page.getByRole("button", { name: "Create card" }).click();
  await expect(page.getByRole("button", { name: "Card: Created in a real browser" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Card: Created in a real browser" })).toBeVisible();
});

test("redirects an unauthenticated browser to the login page and logs in", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  // A browser navigation to a protected page lands on the login form.
  await page.goto(`${baseUrl}/`);
  await expect(page).toHaveURL(`${baseUrl}/login?next=${encodeURIComponent("/")}`);
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();

  // A machine-readable request is still rejected with 401, not redirected.
  const apiResponse = await context.request.get(`${baseUrl}/health`, {
    headers: { accept: "application/json" },
  });
  expect(apiResponse.status()).toBe(401);

  // A wrong key surfaces an inline error instead of authenticating.
  await page.getByLabel("API key").fill("wrong-key");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid API key");

  // Entering the correct key authenticates and returns to the target page.
  await page.getByLabel("API key").fill(apiKey);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(`${baseUrl}/`);
  await expect(page.getByRole("link", { name: "Browser project" })).toBeVisible();

  await context.close();
});

test("creates a project from the list page and opens it", async ({ page }) => {
  await page.goto(`${baseUrl}/?api_key=${encodeURIComponent(apiKey)}`);

  // A blank name is refused without leaving the page.
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("alert")).toContainText("Project name is required");

  await page.getByLabel("New project name").fill("Made in the browser");
  await page.getByRole("button", { name: "Create project" }).click();

  const created = page.getByRole("link", { name: "Made in the browser" });
  await expect(created).toBeVisible();
  // The input clears so the next project can be typed straight away.
  await expect(page.getByLabel("New project name")).toHaveValue("");

  // The default bundle and layer came with it, so the canvas is usable.
  await created.click();
  await expect(page.getByLabel("Write a card")).toBeFocused();
});
