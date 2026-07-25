import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-db-e2e-"));
  tempRoots.push(root);
  return root;
}

function runCli(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
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

function outputId(output: string): string {
  const match = output.match(/^\s*id\s*:\s*(\S+)/m);
  if (!match) throw new Error(`Command output did not contain an ID:\n${output}`);
  return match[1];
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("database CLI flow", () => {
  it("reports the initialized database as current", () => {
    const root = tempWorkspace();
    cli(root, "init");

    const output = cli(root, "db", "status");

    expect(output).toContain(`Database: ${join(root, ".kozane", "kozane.db")}`);
    expect(output).toContain("Status  : current");
    expect(output).toMatch(/Latest\s+:\s+\S+/);
    expect(output).toMatch(/Applied\s+:\s+\S+/);
  }, 30_000);

  it("exports compact JSON to stdout and formatted JSON to a file", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Exported project"));
    cli(root, "card", "add", "Exported card", "--project", projectId);

    const compact = cli(root, "db", "export", "--compact");
    const parsed = JSON.parse(compact);
    expect(compact).not.toContain("\n  ");
    expect(parsed.kind).toBe("kozane.db.export");
    expect(parsed.tables.project).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Exported project" })]),
    );
    expect(parsed.tables.card).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "Exported card" })]),
    );

    const target = join(root, "export.json");
    expect(cli(root, "db", "export", target)).toContain(`Database exported: ${target}`);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("\n  ");
  }, 30_000);

  it("refuses a non-forced import and restores exported rows with --force", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Round-trip project"));
    cli(root, "card", "add", "Round-trip card", "--project", projectId);
    const dump = join(root, "round-trip.json");
    cli(root, "db", "export", dump);

    cli(root, "project", "delete", projectId);
    expect(cli(root, "project", "list")).not.toContain("Round-trip project");

    const refused = runCli(root, "db", "import", dump);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Database is not empty; refusing to import without --force.");

    const output = cli(root, "db", "import", dump, "--force");
    expect(output).toContain(`Database imported: ${dump}`);
    expect(output).toMatch(/Backup created: .*\.kozane\/backups\//);
    expect(output).toContain("project: 2");
    expect(output).toContain("card: 1");
    expect(cli(root, "project", "list")).toContain("Round-trip project");
    expect(cli(root, "card", "list", "--project", projectId)).toContain("Round-trip card");
  }, 30_000);

  it("restores an explicit database backup", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const projectId = outputId(cli(root, "project", "create", "Restored project"));
    const backup = join(root, "known-good.db");
    copyFileSync(join(root, ".kozane", "kozane.db"), backup);

    cli(root, "project", "delete", projectId);
    expect(cli(root, "project", "list")).not.toContain("Restored project");

    const output = cli(root, "db", "restore", backup);
    expect(output).toContain(`Restored: ${backup}`);
    expect(output).toMatch(/Current database backed up: .*\.kozane\/backups\//);
    expect(cli(root, "project", "list")).toContain("Restored project");
  }, 30_000);
});
