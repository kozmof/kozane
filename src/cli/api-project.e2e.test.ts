import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-api-project-e2e-"));
  tempRoots.push(root);
  return root;
}

function runCli(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, TMPDIR: tmpdir(), NO_COLOR: "1" },
  });
}

function cli(cwd: string, ...args: string[]): string {
  const result = runCli(cwd, ...args);
  if (result.status !== 0) {
    throw new Error(
      [`kozane ${args.join(" ")} failed (${result.status})`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

function outputId(output: string): string {
  const match = output.match(/^\s*id\s*:\s*(\S+)/m);
  if (!match) throw new Error(`Command output did not contain an ID:\n${output}`);
  return match[1];
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("API key CLI flow", () => {
  it("generates and refreshes a private API key", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const keyPath = join(root, ".kozane", "api.json");

    expect(runCli(root, "api", "key", "refresh")).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("No API key exists"),
    });

    const generatedOutput = cli(root, "api", "key", "generate");
    const generated = JSON.parse(readFileSync(keyPath, "utf-8"));
    expect(generatedOutput).toContain(generated.apiKey);
    expect(generated.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    expect(runCli(root, "api", "key", "generate")).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("An API key already exists"),
    });

    const refreshedOutput = cli(root, "api", "key", "refresh");
    const refreshed = JSON.parse(readFileSync(keyPath, "utf-8"));
    expect(refreshedOutput).toContain(refreshed.apiKey);
    expect(refreshed.apiKey).not.toBe(generated.apiKey);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  }, 30_000);
});

describe("project, status, and doctor CLI flow", () => {
  it("changes the default project and uses it for subsequent card commands", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "New default"));

    expect(cli(root, "project", "default", projectId)).toContain("Default project changed.");
    const projects = cli(root, "project", "list");
    expect(projects).toMatch(/New default\s+\(default\)/);
    expect(projects).not.toMatch(/main\s+\(default\)/);

    cli(root, "card", "add", "Implicitly routed");
    expect(cli(root, "card", "list", "--project", projectId)).toContain("Implicitly routed");

    const missing = runCli(root, "project", "default", "ffff");
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("Project not found: ffff");
  }, 30_000);

  it("reports workspace entity counts and healthy diagnostics", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Counted"));
    const scopeId = outputId(cli(root, "scope", "add", "Counted scope"));
    cli(root, "card", "add", "Counted card", "--project", projectId);
    cli(
      root,
      "taskspace",
      "create",
      "counted-taskspace",
      "--scope",
      scopeId,
      "--project",
      projectId,
    );

    const status = cli(root, "status");
    expect(status).toContain("Opening      : stopped");
    expect(status).toContain("Projects     : 2");
    expect(status).toContain("Bundles      : 2");
    expect(status).toContain("Cards        : 1");
    expect(status).toContain("Scopes       : 1");
    expect(status).toContain("Taskspaces: 1");

    const configPath = join(root, ".kozane", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.server.port = 0;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    const doctor = cli(root, "doctor");
    expect(doctor).toContain("✓  Kozane workspace found");
    expect(doctor).toContain("✓  DB migrations current");
    expect(doctor).toContain("✓  Port 0 available");
  }, 30_000);

  it("fails clearly outside a workspace and for an invalid workspace config", () => {
    const outside = tempWorkspace();
    for (const command of [["status"], ["doctor"], ["project", "list"]]) {
      const result = runCli(outside, ...command);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Kozane workspace");
    }

    // An unreadable config is the case doctor exists for, so it reports the failed check
    // and points at `doctor config` rather than dying on the parse error.
    const root = tempWorkspace();
    cli(root, "init");
    writeFileSync(join(root, ".kozane", "config.json"), "{ invalid json");
    const doctor = runCli(root, "doctor");
    expect(doctor.status).not.toBe(0);
    expect(doctor.stdout).toContain("✗  config.json valid — run kozane doctor config");
  }, 30_000);
});

describe("safe open CLI validation", () => {
  it("rejects unsafe remote binding combinations before starting a server", () => {
    const root = tempWorkspace();
    cli(root, "init");

    const noOptIn = runCli(root, "open", "--host", "0.0.0.0", "--no-open");
    expect(noOptIn.status).toBe(1);
    expect(noOptIn.stderr).toContain("Use --allow-remote");

    const noKey = runCli(root, "open", "--host", "0.0.0.0", "--allow-remote", "--no-open");
    expect(noKey.status).toBe(1);
    expect(noKey.stderr).toContain("--allow-remote requires an API key");

    cli(root, "api", "key", "generate");
    const opensBrowser = runCli(root, "open", "--host", "0.0.0.0", "--allow-remote");
    expect(opensBrowser.status).toBe(1);
    expect(opensBrowser.stderr).toContain("Run with --no-open");
  }, 30_000);
});
