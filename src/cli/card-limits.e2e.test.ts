import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT_MAX } from "../lib/constants.js";

/**
 * The CLI writes cards to the same table the HTTP routes do, through the same `addCard`.
 * These hold it to the rules the routes enforce — the card text limit and the workspace's
 * own board — because a rule applied on one path only is not a rule the database has.
 */

const cliEntry = resolve("src/cli/index.ts");
const tsxLoader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const tempRoots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "kozane-card-limits-e2e-"));
  tempRoots.push(root);
  return root;
}

function run(cwd: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], {
    cwd,
    encoding: "utf-8",
    ...(input !== undefined && { input }),
    env: { ...process.env, TMPDIR: tmpdir(), NO_COLOR: "1" },
  });
}

function cli(cwd: string, ...args: string[]): string {
  const result = run(cwd, args);
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

function configureUi(root: string, overrides: Record<string, unknown>): void {
  const path = join(root, ".kozane", "config.json");
  const config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const ui = (config.ui ?? {}) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...config, ui: { ...ui, ...overrides } }));
}

function configureCanvas(root: string, canvasWidth: number, canvasHeight: number): void {
  configureUi(root, { canvasWidth, canvasHeight });
}

/** Every card of the workspace as `card list` prints it: `<id> <bundle> (<x>, <y>) <text>`. */
function listedPositions(root: string): { posX: number; posY: number }[] {
  return cli(root, "card", "list")
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/\((-?\d+), (-?\d+)\)/);
      return match ? [{ posX: Number(match[1]), posY: Number(match[2]) }] : [];
    });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("card add", () => {
  it("accepts text at the limit", () => {
    const root = tempWorkspace();
    cli(root, "init");
    expect(cli(root, "card", "add", "x".repeat(CONTENT_MAX))).toContain("Card added.");
  });

  it("refuses text past the limit, in the same words the API uses", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const result = run(root, ["card", "add", "x".repeat(CONTENT_MAX + 1)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`content must be a string under ${CONTENT_MAX} characters`);
    expect(cli(root, "card", "list")).toContain("No cards found.");
  });

  it("accepts text the built-in default would refuse once ui.contentMax is raised", () => {
    const root = tempWorkspace();
    cli(root, "init");
    configureUi(root, { contentMax: 20_000 });
    expect(cli(root, "card", "add", "x".repeat(CONTENT_MAX + 1))).toContain("Card added.");
  });

  it("refuses text the built-in default would accept once ui.contentMax is lowered", () => {
    const root = tempWorkspace();
    cli(root, "init");
    configureUi(root, { contentMax: 280 });
    const result = run(root, ["card", "add", "x".repeat(281)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("content must be a string under 280 characters");
    expect(cli(root, "card", "list")).toContain("No cards found.");
  });

  it("holds --x and --y inside the workspace's board", () => {
    const root = tempWorkspace();
    cli(root, "init");
    configureCanvas(root, 900, 700);
    cli(root, "card", "add", "--x", "999999", "--y", "999999", "far away");
    expect(listedPositions(root)).toEqual([{ posX: 900, posY: 700 }]);
  });

  it("pulls a negative position back to the origin", () => {
    const root = tempWorkspace();
    cli(root, "init");
    cli(root, "card", "add", "--x", "-500", "--y", "-500", "behind the board");
    expect(listedPositions(root)).toEqual([{ posX: 0, posY: 0 }]);
  });

  it("leaves a position already on the board alone", () => {
    const root = tempWorkspace();
    cli(root, "init");
    configureCanvas(root, 900, 700);
    cli(root, "card", "add", "--x", "120", "--y", "340", "on the board");
    expect(listedPositions(root)).toEqual([{ posX: 120, posY: 340 }]);
  });
});

describe("card squash", () => {
  it("refuses when one segment is past the limit, naming which", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const result = run(root, ["card", "squash"], `short. ${"x".repeat(CONTENT_MAX + 1)}. tail`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Card 2 of 3");
    expect(result.stderr).toContain(`content must be a string under ${CONTENT_MAX} characters`);
    // Refused before anything was written, so the workspace is as it was.
    expect(cli(root, "card", "list")).toContain("No cards found.");
  });

  it("holds each segment to the workspace's own ui.contentMax", () => {
    const root = tempWorkspace();
    cli(root, "init");
    configureUi(root, { contentMax: 280 });
    const result = run(root, ["card", "squash"], `short. ${"x".repeat(281)}. tail`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Card 2 of 3");
    expect(result.stderr).toContain("content must be a string under 280 characters");
    expect(cli(root, "card", "list")).toContain("No cards found.");
  });

  it("lays out against the workspace's board rather than the built-in default", () => {
    const root = tempWorkspace();
    cli(root, "init");
    // Narrow enough to hold a single 280px column, so every card wraps to its own row.
    configureCanvas(root, 400, 4000);
    cli(root, "card", "squash", "one. two. three");

    const positions = listedPositions(root);
    expect(positions).toHaveLength(3);
    expect(positions.every(({ posX }) => posX <= 400)).toBe(true);
    expect(new Set(positions.map(({ posY }) => posY)).size).toBe(3);
  });

  // A single column wraps nothing, so the rows run straight down past the foot of the
  // shortest board the config allows. They are clamped back onto it rather than stored
  // somewhere the viewport cannot scroll to.
  it("keeps every card inside the board when the rows run past its foot", () => {
    const root = tempWorkspace();
    cli(root, "init");
    configureCanvas(root, 400, 400);
    cli(root, "card", "squash", "one. two. three. four. five");

    const positions = listedPositions(root);
    expect(positions).toHaveLength(5);
    expect(positions.every(({ posX, posY }) => posX <= 400 && posY <= 400)).toBe(true);
    // The rows that fit keep their spacing; only the ones past the edge are pulled in.
    expect(positions.map(({ posY }) => posY).sort((a, b) => a - b)).toEqual([
      0, 160, 320, 400, 400,
    ]);
  });

  it("still adds every segment of a piped file", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const result = run(root, ["card", "squash"], "one. two. three. four");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("4 cards added.");
  });
});

describe("card move", () => {
  it("moves a card by short ID to the requested position", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const cardId = outputId(cli(root, "card", "add", "moving card"));

    const output = cli(root, "card", "move", cardId, "--x", "120", "--y", "340");

    expect(output).toContain("Card moved.");
    expect(output).toContain("position: (120, 340)");
    expect(listedPositions(root)).toEqual([{ posX: 120, posY: 340 }]);
  });

  it("holds a moved card inside the workspace's configured board", () => {
    const root = tempWorkspace();
    cli(root, "init");
    configureCanvas(root, 900, 700);
    const cardId = outputId(cli(root, "card", "add", "bounded card"));

    cli(root, "card", "move", cardId, "--x", "999999", "--y", "-500");

    expect(listedPositions(root)).toEqual([{ posX: 900, posY: 0 }]);
  });

  it("moves each axis relative to its current position", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const cardId = outputId(cli(root, "card", "add", "relative card", "--x", "120", "--y", "340"));

    const output = cli(root, "card", "move", cardId, "--x", "current+100", "--y", "current-20");

    expect(output).toContain("position: (220, 320)");
    expect(listedPositions(root)).toEqual([{ posX: 220, posY: 320 }]);
  });

  it("moves only the specified axis", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const cardId = outputId(cli(root, "card", "add", "one-axis card", "--x", "120", "--y", "340"));

    cli(root, "card", "move", cardId, "--x", "current+10");
    expect(listedPositions(root)).toEqual([{ posX: 130, posY: 340 }]);

    cli(root, "card", "move", cardId, "--y", "200");
    expect(listedPositions(root)).toEqual([{ posX: 130, posY: 200 }]);
  });

  it("requires at least one axis", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const cardId = outputId(cli(root, "card", "add", "stationary card"));

    const result = run(root, ["card", "move", cardId]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("card move requires --x or --y.");
    expect(listedPositions(root)).toEqual([{ posX: 0, posY: 0 }]);
  });

  it("rejects malformed relative positions", () => {
    const root = tempWorkspace();
    cli(root, "init");
    const cardId = outputId(cli(root, "card", "add", "stationary card"));

    const result = run(root, ["card", "move", cardId, "--x", "current*2", "--y", "current+20"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Must be an integer or relative position");
    expect(listedPositions(root)).toEqual([{ posX: 0, posY: 0 }]);
  });
});
