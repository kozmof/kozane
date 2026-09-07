import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SNAPSHOT_ETAG_PROJECTS_MAX } from "../constants.js";
import {
  _resetSnapshotEtagsForTest,
  matchesEtag,
  rememberSnapshotEtag,
  snapshotEtag,
  unchangedSnapshotEtag,
} from "./snapshot-etag.js";

let root: string;
let dbPath: string;
let dbUrl: string;

/** Rewrites the database file so its signature moves, the way any commit would. */
function touchDatabase(contents: string): void {
  writeFileSync(dbPath, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-snapshot-etag-"));
  dbPath = join(root, "kozane.db");
  dbUrl = `file:${dbPath}`;
  touchDatabase("one");
  _resetSnapshotEtagsForTest();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("snapshotEtag", () => {
  it("is stable for the same bytes and different for others", () => {
    expect(snapshotEtag("body")).toBe(snapshotEtag("body"));
    expect(snapshotEtag("body")).not.toBe(snapshotEtag("other"));
    expect(snapshotEtag("body")).toMatch(/^"[\w-]+"$/);
  });
});

describe("matchesEtag", () => {
  const etag = '"abc"';

  it("accepts the tag itself, a weak validator, a list, and a wildcard", () => {
    expect(matchesEtag(etag, etag)).toBe(true);
    expect(matchesEtag(`W/${etag}`, etag)).toBe(true);
    expect(matchesEtag(`"stale", ${etag}`, etag)).toBe(true);
    expect(matchesEtag("*", etag)).toBe(true);
  });

  it("refuses an absent or unrelated tag", () => {
    expect(matchesEtag(null, etag)).toBe(false);
    expect(matchesEtag('"stale"', etag)).toBe(false);
    expect(matchesEtag("", etag)).toBe(false);
  });
});

describe("unchangedSnapshotEtag", () => {
  it("answers nothing until a tag has been remembered", () => {
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBeNull();
  });

  it("answers the remembered tag while the database file has not moved", () => {
    rememberSnapshotEtag(dbUrl, "p1", '"tag"');
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBe('"tag"');
  });

  it("stops answering once the database has been written to", () => {
    rememberSnapshotEtag(dbUrl, "p1", '"tag"');
    // A different length as well as different bytes: `fileSignature` documents that two
    // same-length rewrites inside one filesystem timestamp tick are indistinguishable to
    // it, and this test is about a commit being noticed, not about closing that gap.
    touchDatabase("one plus more");
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBeNull();
  });

  it("keeps one project's tag out of another's answer", () => {
    rememberSnapshotEtag(dbUrl, "p1", '"tag-1"');
    expect(unchangedSnapshotEtag(dbUrl, "p2")).toBeNull();
    rememberSnapshotEtag(dbUrl, "p2", '"tag-2"');
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBe('"tag-1"');
    expect(unchangedSnapshotEtag(dbUrl, "p2")).toBe('"tag-2"');
  });

  it("declines for a database with no file behind it", () => {
    // The in-memory case, and the reason the gate is off in most of the test suite: there
    // is nothing to stat, so there is no way to know the database has not moved.
    rememberSnapshotEtag(":memory:", "p1", '"tag"');
    expect(unchangedSnapshotEtag(":memory:", "p1")).toBeNull();
    expect(unchangedSnapshotEtag("file::memory:?cache=shared", "p1")).toBeNull();
  });

  it("declines when no database has been opened at all", () => {
    rememberSnapshotEtag(null, "p1", '"tag"');
    expect(unchangedSnapshotEtag(null, "p1")).toBeNull();
  });

  it("declines for a file that is not there", () => {
    const gone = `file:${join(root, "absent.db")}`;
    rememberSnapshotEtag(gone, "p1", '"tag"');
    expect(unchangedSnapshotEtag(gone, "p1")).toBeNull();
  });

  it("keeps the most recently used projects and drops the idlest", () => {
    const ids = Array.from({ length: SNAPSHOT_ETAG_PROJECTS_MAX + 1 }, (_, i) => `p${i}`);
    for (const id of ids) rememberSnapshotEtag(dbUrl, id, `"${id}"`);

    expect(unchangedSnapshotEtag(dbUrl, ids[0])).toBeNull();
    for (const id of ids.slice(1)) expect(unchangedSnapshotEtag(dbUrl, id)).toBe(`"${id}"`);
  });

  it("moves a re-remembered project back to the end of the queue", () => {
    const ids = Array.from({ length: SNAPSHOT_ETAG_PROJECTS_MAX }, (_, i) => `p${i}`);
    for (const id of ids) rememberSnapshotEtag(dbUrl, id, `"${id}"`);

    // Re-remembering `p0` must move it, or the eviction below would order the map by
    // first-seen and discard the project being polled rather than the idle one.
    rememberSnapshotEtag(dbUrl, "p0", '"p0"');
    rememberSnapshotEtag(dbUrl, "fresh", '"fresh"');

    expect(unchangedSnapshotEtag(dbUrl, "p0")).toBe('"p0"');
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBeNull();
  });
});
