import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-tag-e2e-"));
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("tag CLI flow", () => {
  it("says so when nothing is tagged", () => {
    const root = tempWorkspace();
    cli(root, "init");

    expect(cli(root, "tag", "list")).toContain("No tags found");
  }, 30_000);

  it("lists a card's tags as a tree", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "caching work 'perf:cache and 'perf");

    const output = cli(root, "tag", "list");

    expect(output).toContain("'perf");
    expect(output).toContain("'cache");
    // One card, however many of its tags reach the node.
    expect(output).toMatch(/'perf\s+1 card/);
  }, 30_000);

  it("leaves prose apostrophes out of the index", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "don't tag this, and 'quoted' stays text");

    expect(cli(root, "tag", "list")).toContain("No tags found");
  }, 30_000);

  it("gathers a tag from a card and a taskspace file together", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "caching work 'perf:cache");
    cli(root, "taskspace", "create", "notes", "--no-scope");
    writeFileSync(join(root, "notes", "README.md"), "intro\nSee 'perf:cache for the plan.\n");

    const output = cli(root, "tag", "show", "perf");

    expect(output).toContain("caching work 'perf:cache");
    expect(output).toContain("README.md:2");
  }, 30_000);

  it("gathers subcategories under their parent", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "deep 'foo:bar:baz");

    expect(cli(root, "tag", "show", "foo")).toContain("deep 'foo:bar:baz");
  }, 30_000);

  it("does not gather a tag that merely starts the same way", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "'foobar is not under foo");

    expect(cli(root, "tag", "show", "foo")).toContain("No cards or files under 'foo");
  }, 30_000);

  it("takes the tag with or without its sigil", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "tagged 'perf");

    expect(cli(root, "tag", "show", "'perf")).toContain("tagged 'perf");
    expect(cli(root, "tag", "show", "perf")).toContain("tagged 'perf");
  }, 30_000);

  it("skips taskspace files with --no-files", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "taskspace", "create", "notes", "--no-scope");
    writeFileSync(join(root, "notes", "README.md"), "See 'perf here.\n");

    expect(cli(root, "tag", "show", "perf")).toContain("README.md");
    expect(cli(root, "tag", "show", "perf", "--no-files")).toContain("No cards or files");
  }, 30_000);

  it("caps a much-used tag and says what it is showing part of", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "taskspace", "create", "notes", "--no-scope");
    // Past TAG_HITS_SHOWN_MAX, on lines of one file, so each is its own row.
    const lines = Array.from({ length: 205 }, (_, i) => `line ${i} 'everywhere`).join("\n");
    writeFileSync(join(root, "notes", "README.md"), `${lines}\n`);

    const output = cli(root, "tag", "show", "everywhere");

    expect(output).toContain("showing the first 200 of 205 file hits");
    expect(output.split("\n").filter((line) => line.includes("README.md:"))).toHaveLength(200);
  }, 30_000);

  it("lists a card found under two tags once", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "caching work 'perf:cache and 'perf");

    const lines = cli(root, "tag", "show", "perf")
      .split("\n")
      .filter((line) => line.includes("caching work"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("'perf 'perf:cache");
  }, 30_000);
});
