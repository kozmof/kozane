import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { removeServerState, writeServerState } from "../lib/server/runtime-state.js";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-card-scope-e2e-"));
  tempRoots.push(root);
  return root;
}

function cli(cwd: string, ...args: string[]): string {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, TMPDIR: tmpdir() },
  });
  if (result.status !== 0) {
    throw new Error(
      [`kozane ${args.join(" ")} failed (${result.status})`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

function cliWithInput(cwd: string, input: string, ...args: string[]): string {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    input,
    env: { ...process.env, TMPDIR: tmpdir() },
  });
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

describe("scoped card taskspace CLI flow", () => {
  it("routes scope commands to the active memory server database", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const sessionDb = join(root, ".kozane", "session.db");
    copyFileSync(join(root, ".kozane", "kozane.db"), sessionDb);
    const session = { memory: true, databaseUrl: `file:${sessionDb}` };
    writeServerState(root, process.pid, session);

    const scopeId = outputId(cli(root, "scope", "add", "Session scope"));
    expect(cli(root, "scope", "list")).toContain("Session scope");

    removeServerState(root);
    expect(cli(root, "scope", "list")).not.toContain("Session scope");

    writeServerState(root, process.pid, session);
    cli(root, "scope", "delete", scopeId);
    expect(cli(root, "scope", "list")).not.toContain("Session scope");
  }, 30_000);

  it("reads squash content from standard input", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Piped project"));

    const output = cliWithInput(
      root,
      "Piped first. パイプ二番目。",
      "card",
      "squash",
      "--project",
      projectId,
    );

    expect(output).toContain("2 cards added.");
    const listed = cli(root, "card", "list", "--project", projectId);
    expect(listed).toContain("Piped first");
    expect(listed).toContain("パイプ二番目");
  }, 30_000);

  it("squashes English and Japanese sentences into individual cards", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Squash project"));
    const scopeId = outputId(cli(root, "scope", "add", "Squash scope"));

    const output = cli(
      root,
      "card",
      "squash",
      "First thought. 第二の考え。  Third thought..",
      "--project",
      projectId,
      "--scope",
      scopeId,
    );

    expect(output).toContain("3 cards added.");
    const listed = cli(root, "card", "list", "--project", projectId);
    expect(listed).toContain("First thought");
    expect(listed).toContain("第二の考え");
    expect(listed).toContain("Third thought");

    cli(root, "taskspace", "create", "squashed", "--scope", scopeId, "--project", projectId);
    const scoped = cli(join(root, "squashed"), "card", "list");
    expect(scoped).toContain("First thought");
    expect(scoped).toContain("第二の考え");
    expect(scoped).toContain("Third thought");
  }, 30_000);

  it("creates a scope, adds scoped cards, and lists them from the taskspace directory", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "E2E project"));
    const scopeId = outputId(cli(root, "scope", "add", "E2E scope"));

    cli(root, "card", "add", "First scoped card", "--project", projectId, "--scope", scopeId);
    cli(root, "card", "add", "Second scoped card", "--project", projectId, "--scope", scopeId);
    cli(root, "card", "add", "Unscoped card", "--project", projectId);

    cli(root, "taskspace", "create", "scope-taskspace", "--scope", scopeId, "--project", projectId);

    const taskspaceDir = join(root, "scope-taskspace");
    expect(existsSync(join(taskspaceDir, ".taskspace.json"))).toBe(true);
    expect(existsSync(join(taskspaceDir, "cards.md"))).toBe(false);

    const listed = cli(taskspaceDir, "card", "list");
    expect(listed).toContain("First scoped card");
    expect(listed).toContain("Second scoped card");
    expect(listed).not.toContain("Unscoped card");
  }, 30_000);

  it("shows card content by its listed short ID", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Show project"));
    const content = "A small observation\nkeeps its line break.";
    const cardId = outputId(cli(root, "card", "add", content, "--project", projectId));

    expect(cli(root, "card", "show", cardId)).toBe(content + "\n");
    expect(() => cli(root, "card", "show", "ffff")).toThrow("Card not found: ffff");
  }, 30_000);

  it("lists cards by distance from a specified card", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Distance project"));
    const originId = outputId(
      cli(root, "card", "add", "Origin", "--project", projectId, "--x", "10", "--y", "10"),
    );
    cli(root, "card", "add", "Far", "--project", projectId, "--x", "16", "--y", "18");
    cli(root, "card", "add", "Near", "--project", projectId, "--x", "13", "--y", "14");

    const lines = cli(root, "card", "nearest", originId).trim().split("\n");
    expect(lines.map((line) => line.match(/(Origin|Near|Far)$/)?.[1])).toEqual([
      "Origin",
      "Near",
      "Far",
    ]);
    expect(lines[0]).toContain("0.00");
    expect(lines[1]).toContain("5.00");
    expect(lines[2]).toContain("10.00");
    expect(() => cli(root, "card", "nearest", "ffff")).toThrow("Card not found: ffff");
  }, 30_000);
});
