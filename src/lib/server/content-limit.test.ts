import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentMax, contentMaxForRoot } from "./content-limit.js";
import { _resetWorkspaceRootForTest } from "../../db/internal/config.js";
import { CONTENT_MAX } from "../constants.js";

let root: string;
const previousRoot = process.env.KOZANE_WORKSPACE_ROOT;

function writeConfig(value: unknown): void {
  writeFileSync(join(root, ".kozane", "config.json"), JSON.stringify(value, null, 2) + "\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-content-limit-"));
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

describe("contentMaxForRoot", () => {
  it("falls back to the built-in limit when the config sets none", () => {
    expect(contentMaxForRoot(root)).toBe(CONTENT_MAX);
  });

  it("reads a raised limit", () => {
    writeConfig({ name: "w", ui: { contentMax: 50_000 } });
    expect(contentMaxForRoot(root)).toBe(50_000);
  });

  it("reads a lowered limit", () => {
    writeConfig({ name: "w", ui: { contentMax: 280 } });
    expect(contentMaxForRoot(root)).toBe(280);
  });

  // Out of range falls back rather than taking the value: the lenient server-side parse
  // drops a bad field, and `kozane doctor config` is what reports it.
  it("falls back when the configured limit is below the allowed floor", () => {
    writeConfig({ name: "w", ui: { contentMax: 1 } });
    expect(contentMaxForRoot(root)).toBe(CONTENT_MAX);
  });

  it("falls back when the configured limit is not a number", () => {
    writeConfig({ name: "w", ui: { contentMax: "lots" } });
    expect(contentMaxForRoot(root)).toBe(CONTENT_MAX);
  });

  it("agrees with the environment-resolved limit for the same workspace", () => {
    writeConfig({ name: "w", ui: { contentMax: 12_345 } });
    expect(contentMaxForRoot(root)).toBe(contentMax());
  });
});

describe("contentMax", () => {
  // The two limits differ in digit count on purpose. `config.json` is rewritten in place
  // rather than renamed over, so its cache signature is (inode, mtime, size) with the
  // inode fixed — and two writes this close together land in one filesystem timestamp
  // tick. A same-size rewrite here would read as the same file and the test would be
  // asserting the clock, not the cache.
  it("picks up an edit to the config without a restart", () => {
    writeConfig({ name: "w", ui: { contentMax: 20_000 } });
    expect(contentMax()).toBe(20_000);
    writeConfig({ name: "w", ui: { contentMax: 300_000 } });
    expect(contentMax()).toBe(300_000);
  });
});
