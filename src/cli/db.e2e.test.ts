import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  /**
   * A workspace is very often initialized inside a checkout, and `.kozane/` holds an API key,
   * this machine's runtime state, and a tag cache quoting lines out of every taskspace file
   * scanned — including taskspaces pointed outside the repository with `--dir`. None of it
   * belongs in source control, and the ignore file goes when the workspace does.
   */
  it("ignores its own directory, so a workspace inside a checkout is not committed", () => {
    const root = tempWorkspace();
    cli(root, "init");

    expect(readFileSync(join(root, ".kozane", ".gitignore"), "utf-8")).toContain("*");
  }, 30_000);

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
    const namespaceId = outputId(cli(root, "namespace", "create", "Exported namespace"));
    cli(root, "card", "add", "Exported card", "--namespace", namespaceId);

    const compact = cli(root, "db", "export", "--compact");
    const parsed = JSON.parse(compact);
    expect(compact).not.toContain("\n  ");
    expect(parsed.kind).toBe("kozane.db.export");
    expect(parsed.tables.namespace).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Exported namespace" })]),
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
    const namespaceId = outputId(cli(root, "namespace", "create", "Round-trip namespace"));
    cli(root, "card", "add", "Round-trip card", "--namespace", namespaceId);
    const dump = join(root, "round-trip.json");
    cli(root, "db", "export", dump);

    cli(root, "namespace", "delete", namespaceId);
    expect(cli(root, "namespace", "list")).not.toContain("Round-trip namespace");

    const refused = runCli(root, "db", "import", dump);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Database is not empty; refusing to import without --force.");

    const output = cli(root, "db", "import", dump, "--force");
    expect(output).toContain(`Database imported: ${dump}`);
    expect(output).toMatch(/Backup created: .*\.kozane\/backups\//);
    expect(output).toContain("namespace: 2");
    expect(output).toContain("card: 1");
    expect(cli(root, "namespace", "list")).toContain("Round-trip namespace");
    expect(cli(root, "card", "list", "--namespace", namespaceId)).toContain("Round-trip card");
  }, 30_000);

  it("restores an explicit database backup", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const namespaceId = outputId(cli(root, "namespace", "create", "Restored namespace"));
    const backup = join(root, "known-good.db");
    copyFileSync(join(root, ".kozane", "kozane.db"), backup);

    cli(root, "namespace", "delete", namespaceId);
    expect(cli(root, "namespace", "list")).not.toContain("Restored namespace");

    const output = cli(root, "db", "restore", backup);
    expect(output).toContain(`Restored: ${backup}`);
    expect(output).toMatch(/Current database backed up: .*\.kozane\/backups\//);
    expect(cli(root, "namespace", "list")).toContain("Restored namespace");
  }, 30_000);
});

/**
 * `kozane db import` takes rows the endpoints and the card commands would have refused, and
 * says so instead of refusing.
 *
 * The decision is in `dumpLimitWarnings`: these limits are workspace settings, so a dump
 * exported from a workspace with a wider canvas or a larger `ui.contentMax` has to remain
 * restorable into one with the defaults. Refusing would mean a backup that cannot be restored
 * because of a policy difference, on the command whose whole purpose is getting data back.
 */
describe("kozane db import — limits", () => {
  it("imports rows past this workspace's limits and warns about them", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "Ordinary card");
    const dump = join(root, "limits.json");
    cli(root, "db", "export", dump);

    // Edited in the dump rather than written through a command, which is the only way such a
    // row arrives: every write path clamps or refuses first.
    const parsed = JSON.parse(readFileSync(dump, "utf-8")) as {
      tables: { card: Record<string, unknown>[]; scope: Record<string, unknown>[] };
    };
    parsed.tables.card[0].content = "x".repeat(200_001);
    parsed.tables.card[0].pos_x = 999_999;
    parsed.tables.scope.push({ id: "wide-scope", name: "n".repeat(300) });
    writeFileSync(dump, JSON.stringify(parsed), "utf-8");

    const result = runCli(root, "db", "import", dump, "--force");
    // Imported, not refused: the rows are there and the command succeeded.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Database imported: ${dump}`);
    expect(result.stdout).toContain("card: 1");

    expect(result.stderr).toContain("Warning: card: 1 card longer than this workspace's");
    expect(result.stderr).toContain("Warning: card: 1 card positioned outside this workspace's");
    expect(result.stderr).toContain("Warning: 1 name longer than the 255-character limit");

    // And findable afterwards, which is the other half of not refusing.
    const doctor = runCli(root, "doctor");
    expect(doctor.stdout).toContain("✗  Rows within workspace limits");
  }, 30_000);

  it("says nothing about a dump that is within every limit", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "Ordinary card");
    const dump = join(root, "within-limits.json");
    cli(root, "db", "export", dump);

    const result = runCli(root, "db", "import", dump, "--force");
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Warning:");
  }, 30_000);
});
