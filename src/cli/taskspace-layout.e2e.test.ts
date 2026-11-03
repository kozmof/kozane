import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function runCli(cwd: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, TMPDIR: tmpdir(), NO_COLOR: "1" },
    // `open` starts a server if it does not refuse, so never wait on it for long.
    timeout: 30_000,
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

const configPath = (root: string) => join(root, ".kozane", "config.json");
const readConfig = (root: string) => JSON.parse(readFileSync(configPath(root), "utf-8"));
function editTaskspaceConfig(root: string, edit: (section: Record<string, unknown>) => void) {
  const config = readConfig(root);
  edit(config.taskspace);
  writeFileSync(configPath(root), JSON.stringify(config, null, 2) + "\n");
}

/**
 * A workspace as an older Kozane left it: `"defaultDir": "."` with no `namespaceDirs`, and a
 * taskspace Kozane created at `<root>/notes`. A directory the user chose with `--dir` sits
 * beside it.
 */
function legacyWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "kozane-layout-e2e-"));
  tempRoots.push(root);
  cli(root, "init");
  editTaskspaceConfig(root, (section) => {
    section.defaultDir = ".";
    section.namespaceDirs = false;
  });
  cli(root, "taskspace", "create", "notes", "--no-scope");
  mkdirSync(join(root, "mine"));
  cli(root, "taskspace", "create", "mine", "--no-scope", "--dir", join(root, "mine"));
  editTaskspaceConfig(root, (section) => {
    delete section.namespaceDirs;
  });
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("old taskspace layout", () => {
  it("blocks open, and doctor --fix moves the directory and updates the config", () => {
    const root = legacyWorkspace();

    const doctor = runCli(root, "doctor");
    expect(doctor.stdout).toContain(
      '✗  Taskspace layout current — config.json still has the old "defaultDir": "."; ' +
        "1 taskspace directory to move; run kozane doctor --fix",
    );

    const open = runCli(root, "open", "--no-open");
    expect(open.status).toBe(1);
    expect(open.stderr).toContain("notes → taskspaces/main/notes");
    expect(open.stderr).toContain('Run "kozane doctor --fix"');

    const fixed = runCli(root, "doctor", "--fix");
    expect(fixed.stdout).toContain('set taskspace.defaultDir to "taskspaces"');
    expect(fixed.stdout).toContain("notes → taskspaces/main/notes");
    expect(fixed.stdout).toContain("✓  Taskspace layout current");

    expect(readConfig(root).taskspace).toMatchObject({ defaultDir: "taskspaces" });
    expect(existsSync(join(root, "notes"))).toBe(false);
    expect(existsSync(join(root, "taskspaces", "main", "notes", ".taskspace.json"))).toBe(true);
    // The user's own directory stays where it was.
    expect(existsSync(join(root, "mine", ".taskspace.json"))).toBe(true);
    expect(cli(root, "taskspace", "list")).toContain(join("taskspaces", "main", "notes"));
    expect(cli(root, "taskspace", "scan")).toContain("Nothing to apply");
  }, 120_000);

  it("leaves a workspace that keeps the old layout on purpose alone", () => {
    const root = legacyWorkspace();
    editTaskspaceConfig(root, (section) => {
      section.namespaceDirs = false;
    });

    expect(runCli(root, "doctor").stdout).toContain("✓  Taskspace layout current");
    const fixed = runCli(root, "doctor", "--fix");
    expect(fixed.stdout).not.toContain("Taskspace layout:");
    expect(existsSync(join(root, "notes", ".taskspace.json"))).toBe(true);
  }, 120_000);

  it("blocks open on the legacy config alone, so new taskspaces never go in the old layout", () => {
    const root = legacyWorkspace();
    cli(root, "doctor", "--fix");
    // Back to the legacy config, with no directory left to move.
    editTaskspaceConfig(root, (section) => {
      section.defaultDir = ".";
    });

    const open = runCli(root, "open", "--no-open");
    expect(open.status).toBe(1);
    expect(open.stderr).toContain('still has the old "defaultDir": "."');
    expect(open.stderr).toContain('Run "kozane doctor --fix"');
    expect(open.stderr).toContain('"namespaceDirs": false');

    cli(root, "doctor", "--fix");
    expect(readConfig(root).taskspace).toMatchObject({ defaultDir: "taskspaces" });
  }, 120_000);

  it("reports a move it cannot make and keeps the directory", () => {
    const root = legacyWorkspace();
    mkdirSync(join(root, "taskspaces", "main", "notes"), { recursive: true });
    writeFileSync(join(root, "taskspaces", "main", "notes", "keep.txt"), "user file");

    const fixed = runCli(root, "doctor", "--fix");
    expect(fixed.stdout).toContain("! could not move notes");
    expect(fixed.stdout).toContain('kept "defaultDir": "." until every directory has moved');
    expect(fixed.stdout).toContain(
      '✗  Taskspace layout current — config.json still has the old "defaultDir": "."; ' +
        "1 taskspace directory to move",
    );
    expect(fixed.status).toBe(1);
    // The config is kept, so open still refuses instead of leaving the directory unmanaged.
    expect(readConfig(root).taskspace).toMatchObject({ defaultDir: "." });
    expect(runCli(root, "open", "--no-open").status).toBe(1);
    expect(existsSync(join(root, "notes", ".taskspace.json"))).toBe(true);
    expect(readFileSync(join(root, "taskspaces", "main", "notes", "keep.txt"), "utf-8")).toBe(
      "user file",
    );
  }, 120_000);
});

describe("current taskspace layout", () => {
  function currentWorkspace() {
    const root = mkdtempSync(join(tmpdir(), "kozane-layout-e2e-"));
    tempRoots.push(root);
    cli(root, "init");
    cli(root, "taskspace", "create", "notes", "--no-scope");
    return root;
  }

  it("passes doctor for a directory out of place after a layout change, and --fix moves it", () => {
    const root = currentWorkspace();
    editTaskspaceConfig(root, (section) => {
      section.namespaceDirs = false;
    });

    const doctor = runCli(root, "doctor");
    expect(doctor.stdout).toContain(
      "✓  Taskspace layout current — 1 taskspace directory not where new ones go; " +
        "kozane doctor --fix moves them",
    );

    const fixed = runCli(root, "doctor", "--fix");
    expect(fixed.stdout).toContain(
      `${join("taskspaces", "main", "notes")} → ${join("taskspaces", "notes")}`,
    );
    expect(existsSync(join(root, "taskspaces", "notes", ".taskspace.json"))).toBe(true);
    expect(fixed.stdout).toMatch(/✓ {2}Taskspace layout current\n/);
  }, 120_000);

  it("fails doctor for a namespacePaths key that matches no namespace", () => {
    const root = currentWorkspace();
    editTaskspaceConfig(root, (section) => {
      section.namespacePaths = { aaaaaaa: "work" };
    });

    const doctor = runCli(root, "doctor");
    expect(doctor.stdout).toContain(
      '✗  taskspace.namespacePaths keys match namespaces — "aaaaaaa" matches no namespace',
    );
    expect(doctor.status).toBe(1);
  }, 120_000);
});

describe("taskspace create inside another taskspace", () => {
  it("refuses, and leaves the outer taskspace untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "kozane-nested-e2e-"));
    tempRoots.push(root);
    cli(root, "init");
    editTaskspaceConfig(root, (section) => {
      section.namespaceDirs = false;
    });
    cli(root, "taskspace", "create", "outer", "--no-scope");
    // Point new taskspaces into the one just made.
    editTaskspaceConfig(root, (section) => {
      section.defaultDir = join("taskspaces", "outer");
    });

    const result = runCli(root, "taskspace", "create", "inner", "--no-scope");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("would be inside the taskspace at");
    expect(existsSync(join(root, "taskspaces", "outer", "inner"))).toBe(false);
    expect(cli(root, "taskspace", "list")).not.toContain("inner");
  });
});
