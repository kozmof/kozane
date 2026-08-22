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
  const root = mkdtempSync(join(tmpdir(), "kozane-cross-project-e2e-"));
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

function outputId(output: string): string {
  const match = output.match(/^\s*id\s*:\s*(\S+)/m);
  if (!match) throw new Error(`Command output did not contain an ID:\n${output}`);
  return match[1];
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The board narrows scopes and taskspaces to one project, so the CLI is the only place a
 * scope or taskspace belonging to another project can be seen at all. These check that it
 * genuinely is — and that `--project` reproduces what a board would draw.
 */
describe("cross-project scope and taskspace views", () => {
  it("scope list names every project a scope reaches, and --project narrows to one", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const alpha = outputId(cli(root, "project", "create", "Alpha"));
    const beta = outputId(cli(root, "project", "create", "Beta"));

    const shared = outputId(cli(root, "scope", "add", "Shared"));
    const alphaOnly = outputId(cli(root, "scope", "add", "AlphaOnly"));
    cli(root, "scope", "add", "Untouched");

    cli(root, "card", "add", "--project", alpha, "--scope", shared, "in alpha");
    cli(root, "card", "add", "--project", beta, "--scope", shared, "in beta");
    cli(root, "card", "add", "--project", alpha, "--scope", alphaOnly, "alpha only");

    const all = cli(root, "scope", "list");
    // The workspace-wide view: both projects named against the shared scope.
    expect(all).toMatch(/Shared\s+Alpha, Beta/);
    expect(all).toMatch(/AlphaOnly\s+Alpha/);
    // Nothing refers to it yet, so it belongs to no project and shows on every board.
    expect(all).toMatch(/Untouched\s+\(unused\)/);

    const betaView = cli(root, "scope", "list", "--project", beta);
    expect(betaView).toContain("Shared");
    expect(betaView).toContain("Untouched");
    // Beta's board has no reason to draw a scope only Alpha's cards are in.
    expect(betaView).not.toContain("AlphaOnly");
  }, 60_000);

  it("taskspace list shows other projects' taskspaces, and --project hides them", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const alpha = outputId(cli(root, "project", "create", "Alpha"));
    const beta = outputId(cli(root, "project", "create", "Beta"));
    const scope = outputId(cli(root, "scope", "add", "Work"));

    cli(root, "taskspace", "create", "alpha-ws", "--project", alpha, "--scope", scope);
    cli(root, "taskspace", "create", "beta-ws", "--project", beta, "--scope", scope);

    const all = cli(root, "taskspace", "list");
    expect(all).toContain("alpha-ws");
    expect(all).toContain("beta-ws");
    // The project and scope each row sits under are what make the list worth reading.
    expect(all).toMatch(/alpha-ws\s+Alpha\s+Work/);
    expect(all).toMatch(/beta-ws\s+Beta\s+Work/);

    const alphaView = cli(root, "taskspace", "list", "--project", alpha);
    expect(alphaView).toContain("alpha-ws");
    expect(alphaView).not.toContain("beta-ws");
  }, 60_000);

  it("reports an empty narrowed list distinctly from an empty workspace", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const alpha = outputId(cli(root, "project", "create", "Alpha"));
    const beta = outputId(cli(root, "project", "create", "Beta"));

    expect(cli(root, "taskspace", "list")).toContain("No taskspaces found.");

    cli(root, "taskspace", "create", "alpha-ws", "--project", alpha, "--no-scope");
    expect(cli(root, "taskspace", "list", "--project", beta)).toContain(
      "No taskspaces found in this project.",
    );
  }, 60_000);
});
