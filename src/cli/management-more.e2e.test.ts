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

describe("additional card lifecycle commands", () => {
  it("edits, re-bundles, moves between projects, and deletes cards by short ID", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const source = outputId(cli(root, "project", "create", "Source"));
    const target = outputId(cli(root, "project", "create", "Target"));
    const ideas = outputId(cli(root, "bundle", "add", "Ideas", "--project", source));
    const cardId = outputId(cli(root, "card", "add", "Draft", "--project", source));

    expect(cli(root, "card", "edit", cardId, "Revised")).toContain("Card updated.");
    expect(cli(root, "card", "show", cardId)).toBe("Revised\n");

    expect(cli(root, "card", "bundle", ideas, cardId)).toContain("moved to bundle");
    expect(cli(root, "card", "list", "--project", source)).toContain("Ideas");

    expect(cli(root, "card", "project", target, cardId)).toContain("moved to project");
    expect(cli(root, "card", "list", "--project", source)).not.toContain("Revised");
    expect(cli(root, "card", "list", "--project", target)).toContain("Ideas");

    expect(cli(root, "card", "delete", cardId)).toContain("1 card deleted.");
    expect(cli(root, "card", "list", "--project", target)).not.toContain("Revised");
  }, 30_000);
});

describe("bundle commands", () => {
  it("lists, adds, and safely deletes a non-default bundle", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const project = outputId(cli(root, "project", "create", "Bundles"));
    const bundle = outputId(cli(root, "bundle", "add", "Temporary", "--project", project));
    const card = outputId(
      cli(root, "card", "add", "Bundled card", "--project", project, "--bundle", bundle),
    );

    expect(cli(root, "bundle", "list", "--project", project)).toContain("Temporary");
    expect(cli(root, "bundle", "delete", bundle, "--project", project)).toContain(
      "Bundle deleted.",
    );
    const listed = cli(root, "card", "list", "--project", project);
    expect(listed).toContain("General");
    expect(listed).toContain("Bundled card");
    expect(() => cli(root, "card", "show", card)).not.toThrow();
  }, 30_000);
});

describe("scope membership commands", () => {
  it("adds and removes cards from a scope", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const project = outputId(cli(root, "project", "create", "Scoped"));
    const scope = outputId(cli(root, "scope", "add", "Review"));
    const card = outputId(cli(root, "card", "add", "Review me", "--project", project));

    expect(cli(root, "scope", "add-cards", scope, card, "--project", project)).toContain(
      "added to scope",
    );
    let exported = JSON.parse(cli(root, "db", "export"));
    expect(exported.tables.scope_rel).toHaveLength(1);

    expect(cli(root, "scope", "remove-cards", scope, card, "--project", project)).toContain(
      "removed from scope",
    );
    exported = JSON.parse(cli(root, "db", "export"));
    expect(exported.tables.scope_rel).toHaveLength(0);
  }, 30_000);
});

describe("warp commands", () => {
  it("adds, lists, and deletes warps by short ID", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const project = outputId(cli(root, "project", "create", "Warps"));
    const warp = outputId(
      cli(root, "warp", "add", "--project", project, "--x", "120", "--y", "340"),
    );

    const listed = cli(root, "warp", "list", "--project", project);
    expect(listed).toContain(warp);
    expect(listed).toContain("(120, 340)");
    expect(cli(root, "warp", "delete", warp, "--project", project)).toContain("Warp deleted.");
    expect(cli(root, "warp", "list", "--project", project)).toContain("No warps found.");
  }, 30_000);
});
