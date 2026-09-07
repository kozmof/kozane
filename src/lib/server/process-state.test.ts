import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkspaceUiConfig } from "../../db/internal/config.js";
import { readApiKey } from "./api-key.js";
import { AUTH_FAILURE_LIMIT, recordAuthFailure } from "./security.js";
import { rememberSnapshotEtag, unchangedSnapshotEtag } from "./snapshot-etag.js";
import { _resetProcessStateForTest } from "./process-state.js";

let root: string;
const previousRoot = process.env.KOZANE_WORKSPACE_ROOT;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-process-state-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(join(root, ".kozane", "config.json"), JSON.stringify({ ui: { defaultZoom: 1.5 } }));
  writeFileSync(
    join(root, ".kozane", "api.json"),
    JSON.stringify({ apiKey: "k", createdAt: new Date().toISOString() }),
  );
  process.env.KOZANE_WORKSPACE_ROOT = root;
  _resetProcessStateForTest();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.KOZANE_WORKSPACE_ROOT;
  else process.env.KOZANE_WORKSPACE_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
  _resetProcessStateForTest();
});

describe("_resetProcessStateForTest", () => {
  it("clears every cache the process keeps between requests", () => {
    // Warm all four of the caches that can be observed from here, then assert one call
    // puts each of them back. The point is the set, not any one member: a test that had to
    // name them individually is a test that could name three of the four.
    getWorkspaceUiConfig();
    readApiKey(root);
    for (let i = 0; i <= AUTH_FAILURE_LIMIT; i += 1) recordAuthFailure("1.2.3.4");
    const dbUrl = `file:${join(root, ".kozane", "config.json")}`;
    rememberSnapshotEtag(dbUrl, "p1", '"tag"');
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBe('"tag"');
    expect(recordAuthFailure("1.2.3.4")).not.toBeNull();

    _resetProcessStateForTest();

    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBeNull();
    // Back under the limit, which it could only be if the window was dropped.
    expect(recordAuthFailure("1.2.3.4")).toBeNull();

    // The workspace root is re-resolved rather than served from the previous answer, which
    // is what lets a test point `KOZANE_WORKSPACE_ROOT` somewhere new.
    const moved = mkdtempSync(join(tmpdir(), "kozane-process-state-moved-"));
    try {
      mkdirSync(join(moved, ".kozane"));
      writeFileSync(
        join(moved, ".kozane", "config.json"),
        JSON.stringify({ ui: { defaultZoom: 2.5 } }),
      );
      process.env.KOZANE_WORKSPACE_ROOT = moved;
      _resetProcessStateForTest();
      expect(getWorkspaceUiConfig().defaultZoom).toBe(2.5);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });
});
