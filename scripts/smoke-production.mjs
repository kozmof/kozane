import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "kozane-production-smoke-"));

function cli(...args) {
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

async function waitForServer(url, apiKey) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) return response;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw lastError ?? new Error("server did not start");
}

let server;
try {
  cli("init");
  cli("project", "create", "Smoke project");
  cli("api", "key", "generate");

  const { apiKey } = JSON.parse(readFileSync(join(workspace, ".kozane", "api.json"), "utf8"));
  const port = String(20_000 + Math.floor(Math.random() * 20_000));
  const baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(packageRoot, "build", "index.js")], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: `file:${join(workspace, ".kozane", "kozane.db")}`,
      KOZANE_WORKSPACE_ROOT: workspace,
      HOST: "127.0.0.1",
      PORT: port,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const health = await waitForServer(`${baseUrl}/health`, apiKey);
  const body = await health.json();
  if (body.status !== "ok") throw new Error("health response was not ready");
  if (health.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error("security headers were missing");
  }

  const page = await fetch(baseUrl, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!page.ok || !(await page.text()).includes("<!doctype html>")) {
    throw new Error(`authenticated application page returned ${page.status}`);
  }

  const unauthorized = await fetch(`${baseUrl}/health`);
  if (unauthorized.status !== 401) {
    throw new Error(`unauthenticated health request returned ${unauthorized.status}`);
  }

  cli("db", "export");
  console.log(
    "Production smoke test passed: package CLI, database, authenticated server, and export.",
  );
} finally {
  if (server && !server.killed) server.kill("SIGTERM");
  rmSync(workspace, { recursive: true, force: true });
}
