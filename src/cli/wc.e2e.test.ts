import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-wc-e2e-"));
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

describe("working-copy CLI flow", () => {
  it("validates create options and supports --no-scope with an explicit directory", () => {
    const root = tempWorkspace();
    cli(root, "init");

    const missingScope = runCli(root, "wc", "create", "missing-scope");
    expect(missingScope.status).not.toBe(0);
    expect(missingScope.stderr).toContain("--scope <scopeId> is required");

    const target = join(root, "nested", "explicit");
    const output = cli(root, "wc", "create", "unscoped", "--no-scope", "--dir", target);
    expect(output).toContain(`path : ${target}`);
    expect(JSON.parse(readFileSync(join(target, ".working-copy.json"), "utf-8"))).toMatchObject({
      kind: "kozane.workingCopy",
      version: 1,
    });

    const duplicate = runCli(root, "wc", "create", "duplicate", "--no-scope", "--dir", target);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("already contains a Kozane working copy");
  }, 30_000);

  it("accepts an explicit project and rejects an unknown project", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Second"));

    expect(cli(root, "wc", "create", "selected", "--no-scope", "--project", projectId)).toContain(
      "Working copy created.",
    );
    const unknown = runCli(root, "wc", "create", "unknown", "--no-scope", "--project", "ffff");
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Project not found: ffff");
  }, 30_000);

  it("detects and applies moved, missing, and orphan working-copy changes", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const scopeId = outputId(cli(root, "scope", "add", "Scan scope"));
    cli(root, "wc", "create", "original", "--scope", scopeId);
    const original = join(root, "original");
    const moved = join(root, "moved");
    const marker = JSON.parse(readFileSync(join(original, ".working-copy.json"), "utf-8"));
    renameSync(original, moved);

    const movedDryRun = cli(root, "wc", "scan");
    expect(movedDryRun).toContain("moved");
    expect(movedDryRun).toContain("wc scan --apply");
    expect(cli(root, "wc", "scan", "--apply")).toContain("1 updated");
    const shortId = marker.workingCopyId.split("-").at(-1).slice(0, 4);
    expect(cli(root, "wc", "scan")).toContain(`ok      ${shortId}`);

    rmSync(moved, { recursive: true, force: true });
    const missingDryRun = cli(root, "wc", "scan");
    expect(missingDryRun).toContain("missing");
    expect(missingDryRun).toContain("--apply --cleanup");
    expect(cli(root, "wc", "scan", "--apply", "--cleanup")).toContain("1 deleted");

    const orphan = join(root, "orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, ".working-copy.json"), JSON.stringify(marker, null, 2) + "\n");
    expect(cli(root, "wc", "scan")).toContain("orphan");
    expect(cli(root, "wc", "scan", "--apply", "--reattach")).toContain("reattached");
    expect(cli(root, "wc", "scan")).toContain("Scan complete. Nothing to apply.");
  }, 30_000);

  it("rejects mutating scan flags without --apply", () => {
    const root = tempWorkspace();
    cli(root, "init");

    for (const option of ["--reattach", "--cleanup"]) {
      const result = runCli(root, "wc", "scan", option);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${option} requires --apply`);
    }
  }, 30_000);
});
