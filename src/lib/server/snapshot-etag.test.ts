import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SNAPSHOT_ETAG_NAMESPACES_MAX } from "../constants.js";
import {
  _resetSnapshotEtagsForTest,
  matchesEtag,
  rememberSnapshotEtag,
  snapshotReadSignature,
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
    rememberSnapshotEtag(dbUrl, "p1", '"tag"', snapshotReadSignature(dbUrl));
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBe('"tag"');
  });

  it("stops answering once the database has been written to", () => {
    rememberSnapshotEtag(dbUrl, "p1", '"tag"', snapshotReadSignature(dbUrl));
    // Change the length as well as the content to avoid the documented same-size,
    // same-timestamp limitation of `fileSignature`.
    touchDatabase("one plus more");
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBeNull();
  });

  it("remembers nothing when the database moved while the read ran", () => {
    // Do not associate a pre-commit snapshot with the post-commit signature, which would
    // allow stale 304 responses.
    const readFrom = snapshotReadSignature(dbUrl);
    touchDatabase("one plus a commit mid-read");
    rememberSnapshotEtag(dbUrl, "p1", '"pre-commit"', readFrom);
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBeNull();
  });

  it("keeps one namespace's tag out of another's answer", () => {
    rememberSnapshotEtag(dbUrl, "p1", '"tag-1"', snapshotReadSignature(dbUrl));
    expect(unchangedSnapshotEtag(dbUrl, "p2")).toBeNull();
    rememberSnapshotEtag(dbUrl, "p2", '"tag-2"', snapshotReadSignature(dbUrl));
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBe('"tag-1"');
    expect(unchangedSnapshotEtag(dbUrl, "p2")).toBe('"tag-2"');
  });

  it("declines for a database with no file behind it", () => {
    // An in-memory database has no file metadata to establish whether it has changed, so the
    // gate stays off.
    rememberSnapshotEtag(":memory:", "p1", '"tag"', snapshotReadSignature(":memory:"));
    expect(unchangedSnapshotEtag(":memory:", "p1")).toBeNull();
    expect(unchangedSnapshotEtag("file::memory:?cache=shared", "p1")).toBeNull();
  });

  it("declines when no database has been opened at all", () => {
    rememberSnapshotEtag(null, "p1", '"tag"', snapshotReadSignature(null));
    expect(unchangedSnapshotEtag(null, "p1")).toBeNull();
  });

  it("declines for a file that is not there", () => {
    const gone = `file:${join(root, "absent.db")}`;
    rememberSnapshotEtag(gone, "p1", '"tag"', snapshotReadSignature(gone));
    expect(unchangedSnapshotEtag(gone, "p1")).toBeNull();
  });

  it("keeps the most recently used namespaces and drops the idlest", () => {
    const ids = Array.from({ length: SNAPSHOT_ETAG_NAMESPACES_MAX + 1 }, (_, i) => `p${i}`);
    for (const id of ids) rememberSnapshotEtag(dbUrl, id, `"${id}"`, snapshotReadSignature(dbUrl));

    expect(unchangedSnapshotEtag(dbUrl, ids[0])).toBeNull();
    for (const id of ids.slice(1)) expect(unchangedSnapshotEtag(dbUrl, id)).toBe(`"${id}"`);
  });

  it("counts answering from the cache as a use", () => {
    const ids = Array.from({ length: SNAPSHOT_ETAG_NAMESPACES_MAX }, (_, i) => `p${i}`);
    for (const id of ids) rememberSnapshotEtag(dbUrl, id, `"${id}"`, snapshotReadSignature(dbUrl));

    // Cache hits must refresh recency so inserting another namespace does not evict the
    // actively polled board.
    expect(unchangedSnapshotEtag(dbUrl, "p0")).toBe('"p0"');
    rememberSnapshotEtag(dbUrl, "fresh", '"fresh"', snapshotReadSignature(dbUrl));

    expect(unchangedSnapshotEtag(dbUrl, "p0")).toBe('"p0"');
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBeNull();
  });

  it("does not create an entry for a namespace it has nothing for", () => {
    const ids = Array.from({ length: SNAPSHOT_ETAG_NAMESPACES_MAX }, (_, i) => `p${i}`);
    for (const id of ids) rememberSnapshotEtag(dbUrl, id, `"${id}"`, snapshotReadSignature(dbUrl));

    // A miss must not take a slot, or probing unknown ids would evict the real entries.
    expect(unchangedSnapshotEtag(dbUrl, "absent")).toBeNull();
    for (const id of ids) expect(unchangedSnapshotEtag(dbUrl, id)).toBe(`"${id}"`);
  });

  it("moves a re-remembered namespace back to the end of the queue", () => {
    const ids = Array.from({ length: SNAPSHOT_ETAG_NAMESPACES_MAX }, (_, i) => `p${i}`);
    for (const id of ids) rememberSnapshotEtag(dbUrl, id, `"${id}"`, snapshotReadSignature(dbUrl));

    // Re-remembering `p0` must move it, or the eviction below would order the map by
    // first-seen and discard the namespace being polled rather than the idle one.
    rememberSnapshotEtag(dbUrl, "p0", '"p0"', snapshotReadSignature(dbUrl));
    rememberSnapshotEtag(dbUrl, "fresh", '"fresh"', snapshotReadSignature(dbUrl));

    expect(unchangedSnapshotEtag(dbUrl, "p0")).toBe('"p0"');
    expect(unchangedSnapshotEtag(dbUrl, "p1")).toBeNull();
  });
});
