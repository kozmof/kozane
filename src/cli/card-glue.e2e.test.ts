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
  const root = mkdtempSync(join(tmpdir(), "kozane-card-glue-e2e-"));
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
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
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

describe("card glue CLI", () => {
  it("glues and individually unglues cards by short ID", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Glue project"));
    const first = outputId(cli(root, "card", "add", "First", "--project", projectId));
    const second = outputId(cli(root, "card", "add", "Second", "--project", projectId));
    expect(cli(root, "card", "glue", first, second)).toContain("2 cards glued.");
    const glued = JSON.parse(cli(root, "db", "export"));
    expect(glued.tables.glue).toHaveLength(1);
    expect(glued.tables.glue_rel).toHaveLength(2);
    expect(cli(root, "card", "unglue", first)).toContain("1 card unglued.");
    const unglued = JSON.parse(cli(root, "db", "export"));
    expect(unglued.tables.glue).toHaveLength(0);
    expect(unglued.tables.glue_rel).toHaveLength(0);
  }, 30_000);

  it("aligns glued cards as a vertical list in argument order", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "List project"));
    const first = outputId(
      cli(root, "card", "add", "First", "--project", projectId, "--x", "96", "--y", "48"),
    );
    const second = outputId(
      cli(root, "card", "add", "Second", "--project", projectId, "--x", "500", "--y", "400"),
    );
    const third = outputId(
      cli(root, "card", "add", "Third", "--project", projectId, "--x", "700", "--y", "600"),
    );

    const output = cli(root, "card", "glue", first, second, third, "--align-list");
    expect(output).toContain("layout: vertical list");
    const listed = cli(root, "card", "list", "--project", projectId);
    const positions = [...listed.matchAll(/\((\d+), (\d+)\)/g)].map((match) => [
      Number(match[1]),
      Number(match[2]),
    ]);
    expect(positions).toEqual([
      [96, 48],
      [96, 144],
      [96, 240],
    ]);
  }, 30_000);

  it("adds cards while preserving and merging existing glue groups", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Additive project"));
    const ids = ["First", "Second", "Third", "Fourth"].map((content) =>
      outputId(cli(root, "card", "add", content, "--project", projectId)),
    );
    cli(root, "card", "glue", ids[0], ids[1]);
    cli(root, "card", "glue", ids[2], ids[3]);

    const output = cli(root, "card", "glue", ids[0], ids[2], "--add");
    expect(output).toContain("4 cards glued.");
    expect(output).toContain("mode: additive");

    const exported = JSON.parse(cli(root, "db", "export"));
    expect(exported.tables.glue).toHaveLength(1);
    expect(exported.tables.glue_rel).toHaveLength(4);
    expect(
      new Set(exported.tables.glue_rel.map((rel: { glue_id: string }) => rel.glue_id)).size,
    ).toBe(1);
  }, 30_000);

  it("rejects cards from different projects without changing glue data", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const firstProject = outputId(cli(root, "project", "create", "First project"));
    const secondProject = outputId(cli(root, "project", "create", "Second project"));
    const first = outputId(cli(root, "card", "add", "First", "--project", firstProject));
    const second = outputId(cli(root, "card", "add", "Second", "--project", secondProject));
    const result = runCli(root, "card", "glue", first, second);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cards must belong to the same project.");
    const exported = JSON.parse(cli(root, "db", "export"));
    expect(exported.tables.glue).toHaveLength(0);
    expect(exported.tables.glue_rel).toHaveLength(0);
  }, 30_000);
});
