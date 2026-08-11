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
  const root = mkdtempSync(join(tmpdir(), "kozane-layer-e2e-"));
  tempRoots.push(root);
  return root;
}

function runCli(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, TMPDIR: tmpdir() },
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

function outputField(output: string, field: string): string {
  const match = output.match(new RegExp(`^\\s*${field}\\s*:\\s*(\\S+)`, "m"));
  if (!match) throw new Error(`Command output did not contain ${field}:\n${output}`);
  return match[1];
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("layer CLI flow", () => {
  it("lists the default layer created by init", () => {
    const root = tempWorkspace();
    cli(root, "init");

    const output = cli(root, "layer", "list");

    expect(output).toContain("Base");
    expect(output).toContain("(default)");
  }, 30_000);

  it("adds a layer, places a card on it by name, and counts it", () => {
    const root = tempWorkspace();
    cli(root, "init");

    const added = cli(root, "layer", "add", "Draft");
    expect(outputField(added, "position")).toBe("1");

    const card = cli(root, "card", "add", "--layer", "Draft", "On the draft layer");
    const layerId = outputField(card, "layer");

    const list = cli(root, "layer", "list");
    // "<id>  <position>  <cards>  <name>": the new layer holds the one card.
    expect(list).toMatch(new RegExp(`^${layerId}\\s+1\\s+1\\s+Draft$`, "m"));
    expect(list).toMatch(/^\S+\s+0\s+0\s+Base \(default\)$/m);
  }, 30_000);

  it("moves cards to the default layer when their layer is deleted", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "layer", "add", "Draft");
    cli(root, "card", "add", "--layer", "Draft", "Survivor");

    const deleted = cli(root, "layer", "delete", layerIdOf(root, "Draft"));
    expect(deleted).toContain("Layer deleted.");

    const list = cli(root, "layer", "list");
    expect(list).not.toContain("Draft");
    // The card was reassigned rather than cascaded away with the layer.
    expect(list).toMatch(/^\S+\s+0\s+1\s+Base \(default\)$/m);
    expect(cli(root, "card", "list")).toContain("Survivor");
  }, 30_000);

  it("renames a layer by name and keeps its cards", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "layer", "add", "Draft");
    cli(root, "card", "add", "--layer", "Draft", "Stays put");

    const renamed = cli(root, "layer", "rename", "Draft", "  Sketches  ");
    expect(outputField(renamed, "name")).toBe("Sketches");

    const list = cli(root, "layer", "list");
    expect(list).not.toContain("Draft");
    expect(list).toMatch(/^\S+\s+1\s+1\s+Sketches$/m);
  }, 30_000);

  it("moves a layer up and down the stack", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "layer", "add", "Draft");

    // Positions are bottom to top, so moving Base up puts it above Draft.
    cli(root, "layer", "move", "Base", "up");
    expect(cli(root, "layer", "list")).toMatch(/^\S+\s+0\s+0\s+Draft$/m);
    expect(cli(root, "layer", "list")).toMatch(/^\S+\s+1\s+0\s+Base \(default\)$/m);

    cli(root, "layer", "move", "Base", "down");
    expect(cli(root, "layer", "list")).toMatch(/^\S+\s+0\s+0\s+Base \(default\)$/m);
    expect(cli(root, "layer", "list")).toMatch(/^\S+\s+1\s+0\s+Draft$/m);
  }, 30_000);

  it("refuses to move a layer past the end of the stack", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "layer", "add", "Draft");

    const result = runCli(root, "layer", "move", "Draft", "up");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already at the top");
  }, 30_000);

  it("rejects a move direction that is not up or down", () => {
    const root = tempWorkspace();
    cli(root, "init");

    const result = runCli(root, "layer", "move", "Base", "sideways");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Direction must be "up" or "down"');
  }, 30_000);

  it("refuses to delete the default layer", () => {
    const root = tempWorkspace();
    cli(root, "init");

    const result = runCli(root, "layer", "delete", layerIdOf(root, "Base"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot delete the default layer");
  }, 30_000);

  function layerIdOf(root: string, name: string): string {
    const line = cli(root, "layer", "list")
      .split("\n")
      .find((row) => row.includes(name));
    if (!line) throw new Error(`No layer named ${name} in:\n${cli(root, "layer", "list")}`);
    return line.trim().split(/\s+/)[0];
  }
});
