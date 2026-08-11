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
