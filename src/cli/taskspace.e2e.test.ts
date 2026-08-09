import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_SHORT_ID_LENGTH } from "./lib/short-id.js";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-taskspace-e2e-"));
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

describe("taskspace CLI flow", () => {
  it("validates create options and supports --no-scope with an explicit directory", () => {
    const root = tempWorkspace();
    cli(root, "init");

    const missingScope = runCli(root, "taskspace", "create", "missing-scope");
    expect(missingScope.status).not.toBe(0);
    expect(missingScope.stderr).toContain("--scope <scopeId> is required");

    const target = join(root, "nested", "explicit");
    const output = cli(root, "taskspace", "create", "unscoped", "--no-scope", "--dir", target);
    expect(output).toContain(`path : ${target}`);
    expect(JSON.parse(readFileSync(join(target, ".taskspace.json"), "utf-8"))).toMatchObject({
      kind: "kozane.taskspace",
      version: 1,
    });

    const duplicate = runCli(
      root,
      "taskspace",
      "create",
      "duplicate",
      "--no-scope",
      "--dir",
      target,
    );
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("already contains a Kozane taskspace");
  }, 30_000);

  it("accepts an explicit project and rejects an unknown project", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Second"));

    expect(
      cli(root, "taskspace", "create", "selected", "--no-scope", "--project", projectId),
    ).toContain("Taskspace created.");
    const unknown = runCli(
      root,
      "taskspace",
      "create",
      "unknown",
      "--no-scope",
      "--project",
      "ffff",
    );
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Project not found: ffff");
  }, 30_000);

  it("detects and applies moved, missing, and orphan taskspace changes", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const scopeId = outputId(cli(root, "scope", "add", "Scan scope"));
    cli(root, "taskspace", "create", "original", "--scope", scopeId);
    const original = join(root, "original");
    const moved = join(root, "moved");
    const marker = JSON.parse(readFileSync(join(original, ".taskspace.json"), "utf-8"));
    renameSync(original, moved);

    const movedDryRun = cli(root, "taskspace", "scan");
    expect(movedDryRun).toContain("moved");
    expect(movedDryRun).toContain("taskspace scan --apply");
    expect(cli(root, "taskspace", "scan", "--apply")).toContain("1 updated");
    // Only one taskspace exists, so its short ID is the minimum width with no
    // collision lengthening. Derived from the constant so it tracks the CLI.
    const shortId = marker.taskspaceId.split("-").at(-1).slice(0, MIN_SHORT_ID_LENGTH);
    expect(cli(root, "taskspace", "scan")).toContain(`ok      ${shortId}`);

    rmSync(moved, { recursive: true, force: true });
    const missingDryRun = cli(root, "taskspace", "scan");
    expect(missingDryRun).toContain("missing");
    expect(missingDryRun).toContain("--apply --cleanup");
    expect(cli(root, "taskspace", "scan", "--apply", "--cleanup")).toContain("1 deleted");

    const orphan = join(root, "orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, ".taskspace.json"), JSON.stringify(marker, null, 2) + "\n");
    expect(cli(root, "taskspace", "scan")).toContain("orphan");
    expect(cli(root, "taskspace", "scan", "--apply", "--reattach")).toContain("reattached");
    expect(cli(root, "taskspace", "scan")).toContain("Scan complete. Nothing to apply.");
  }, 30_000);

  it("rejects mutating scan flags without --apply", () => {
    const root = tempWorkspace();
    cli(root, "init");

    for (const option of ["--reattach", "--cleanup"]) {
      const result = runCli(root, "taskspace", "scan", option);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${option} requires --apply`);
    }
  }, 30_000);
});
