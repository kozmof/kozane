import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

const validConfig = {
  name: "demo",
  server: { host: "127.0.0.1", port: 17173 },
  taskspace: { defaultDir: ".", searchRoots: ["."] },
};

/**
 * `doctor config` only needs the config file to find the workspace, so these cases skip
 * `kozane init` and its migrations.
 */
function tempWorkspace(config?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-doctor-config-e2e-"));
  tempRoots.push(root);
  if (config !== undefined) {
    mkdirSync(join(root, ".kozane"), { recursive: true });
    const body = typeof config === "string" ? config : JSON.stringify(config, null, 2);
    writeFileSync(join(root, ".kozane", "config.json"), body, "utf-8");
  }
  return root;
}

function runCli(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, TMPDIR: tmpdir(), NO_COLOR: "1" },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("kozane doctor config", () => {
  it("passes on a valid config and reports the defaults in effect", () => {
    const root = tempWorkspace({ name: "demo", taskspace: validConfig.taskspace });
    const result = runCli(root, "doctor", "config");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No problems found");
    expect(result.stdout).toContain("  ℹ  server: 2 of 2 keys not set — using defaults");
    expect(result.stdout).toContain(`       host: "127.0.0.1"`);
    expect(result.stdout).toContain("       port: 17173");
    expect(result.stdout).toContain("       defaultFontSize: 11.5");
  });

  it("reports missing keys, unknown keys, and invalid values together", () => {
    const root = tempWorkspace({
      server: { port: 70000, protocol: "https" },
      taskspace: { defaultDir: ".", searchRoots: ["."] },
      ui: { defaultFontSze: 14 },
    });
    const result = runCli(root, "doctor", "config");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("name is missing");
    expect(result.stdout).toContain("server.port must be between 0 and 65535 (found: 70000)");
    expect(result.stdout).toContain("server.protocol is not a known key");
    expect(result.stdout).toContain(`did you mean "defaultFontSize"?`);
    expect(result.stdout).toContain("2 errors, 2 warnings");
  });

  it("passes on unknown keys alone unless --strict is given", () => {
    const root = tempWorkspace({ ...validConfig, colour: "red" });

    const lenient = runCli(root, "doctor", "config");
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain("colour is not a known key");
    expect(lenient.stdout).toContain("0 errors, 1 warning");

    expect(runCli(root, "doctor", "config", "--strict").status).toBe(1);
  });

  it("reports a config that is not valid JSON", () => {
    const root = tempWorkspace("{ not json");
    const result = runCli(root, "doctor", "config");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("config.json is not valid JSON");
  });

  it("fails outside a workspace", () => {
    const result = runCli(tempWorkspace(), "doctor", "config");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Run "kozane init" first');
  });

  it("keeps kozane doctor reporting when the config is unreadable", () => {
    const root = tempWorkspace({ name: "demo", taskspace: { defaultDir: 7 } });
    const result = runCli(root, "doctor");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Kozane workspace found");
    expect(result.stdout).toContain("config.json valid — run kozane doctor config");
  }, 30_000);
});
