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
  const root = mkdtempSync(join(tmpdir(), "kozane-management-more-e2e-"));
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

function cli(cwd: string, ...args: string[]): string {
  const result = runCli(cwd, ...args);
  if (result.status !== 0)
    throw new Error(
      [`kozane ${args.join(" ")} failed (${result.status})`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
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

describe("inventory service CLI integration", () => {
  it("creates renames stores takes repairs and deletes through short IDs", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const namespace = outputId(cli(root, "namespace", "create", "Inventory fixture"));
    const card = outputId(cli(root, "card", "add", "Stored text", "--namespace", namespace));
    const inventory = outputId(
      cli(
        root,
        "inventory",
        "add",
        "--namespace",
        namespace,
        "--name",
        "Tray",
        "--x",
        "100",
        "--y",
        "200",
      ),
    );
    expect(
      cli(root, "inventory", "rename", inventory, "Renamed", "--namespace", namespace),
    ).toContain("Inventory renamed.");
    expect(cli(root, "inventory", "put", inventory, card, "--slot", "0")).toContain(
      "1 card stored.",
    );
    expect(cli(root, "inventory", "show", inventory, "--namespace", namespace)).toContain(
      "Stored text",
    );
    expect(cli(root, "inventory", "take", card, "--x", "300", "--y", "400")).toContain(
      "1 card returned to the canvas.",
    );
    const refused = runCli(root, "inventory", "take", card);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Only stored cards can be taken out.");
    expect(cli(root, "inventory", "repair")).toContain("Inventories already consistent.");
    expect(cli(root, "inventory", "delete", inventory, "--namespace", namespace)).toContain(
      "Inventory deleted.",
    );
  }, 30000);
});
