import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-parser-e2e-"));
  tempRoots.push(root);
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

describe("CLI parser and workspace errors", () => {
  it("prints help and version", () => {
    const root = tempWorkspace();
    const help = runCli(root, "--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Local card-based thinking workspace");
    expect(help.stdout).toContain("Database management");

    const version = runCli(root, "--version");
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("rejects unknown commands and invalid integer options", () => {
    const root = tempWorkspace();
    const unknown = runCli(root, "unknown");
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("unknown command");

    expect(runCli(root, "init").status).toBe(0);
    const invalid = runCli(root, "card", "add", "Card", "--x", "1.5");
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("Must be an integer");
  }, 30_000);

  it("rejects workspace commands outside a workspace and duplicate initialization", () => {
    const root = tempWorkspace();
    const outside = runCli(root, "card", "list");
    expect(outside.status).not.toBe(0);
    expect(outside.stderr).toContain('Run "kozane init" first');

    expect(runCli(root, "init").status).toBe(0);
    const duplicate = runCli(root, "init");
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("Kozane workspace already exists");
  }, 30_000);
});
