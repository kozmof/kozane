import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canvasBounds, canvasBoundsForRoot, clampToBounds, clampToCanvas } from "./canvas.js";
import { _resetWorkspaceRootForTest } from "../../db/internal/config.js";
import { CANVAS_H, CANVAS_W } from "../constants.js";

let root: string;
const previousRoot = process.env.KOZANE_WORKSPACE_ROOT;

function writeConfig(value: unknown): void {
  writeFileSync(join(root, ".kozane", "config.json"), JSON.stringify(value, null, 2) + "\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-canvas-"));
  mkdirSync(join(root, ".kozane"));
  writeConfig({ name: "w" });
  process.env.KOZANE_WORKSPACE_ROOT = root;
  _resetWorkspaceRootForTest();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.KOZANE_WORKSPACE_ROOT;
  else process.env.KOZANE_WORKSPACE_ROOT = previousRoot;
  _resetWorkspaceRootForTest();
  rmSync(root, { recursive: true, force: true });
});

describe("clampToBounds", () => {
  const bounds = { canvasWidth: 1000, canvasHeight: 800 };

  it("leaves a position already on the board alone", () => {
    expect(clampToBounds(120, 340, bounds)).toEqual({ posX: 120, posY: 340 });
  });

  it("pulls a negative position back to the origin", () => {
    expect(clampToBounds(-40, -1, bounds)).toEqual({ posX: 0, posY: 0 });
  });

  it("pulls a position past the far edge back onto it", () => {
    expect(clampToBounds(99_999, 99_999, bounds)).toEqual({ posX: 1000, posY: 800 });
  });

  it("clamps each axis against its own bound", () => {
    expect(clampToBounds(900, 99_999, bounds)).toEqual({ posX: 900, posY: 800 });
  });
});

describe("canvasBoundsForRoot", () => {
  it("falls back to the built-in board when the config sets no size", () => {
    expect(canvasBoundsForRoot(root)).toEqual({
      canvasWidth: CANVAS_W,
      canvasHeight: CANVAS_H,
    });
  });

  it("reads the workspace's own board size", () => {
    writeConfig({ name: "w", ui: { canvasWidth: 900, canvasHeight: 700 } });
    expect(canvasBoundsForRoot(root)).toEqual({ canvasWidth: 900, canvasHeight: 700 });
  });

  // The reason this function exists: a CLI holding the root must land cards on the same
  // board the server clamps to, not on the built-in default.
  it("agrees with the environment-resolved bounds for the same workspace", () => {
    writeConfig({ name: "w", ui: { canvasWidth: 1234, canvasHeight: 999 } });
    expect(canvasBoundsForRoot(root)).toEqual(canvasBounds());
  });
});

describe("clampToCanvas", () => {
  it("holds a position inside the workspace's configured board", () => {
    writeConfig({ name: "w", ui: { canvasWidth: 900, canvasHeight: 700 } });
    expect(clampToCanvas(5000, 5000)).toEqual({ posX: 900, posY: 700 });
  });
});
