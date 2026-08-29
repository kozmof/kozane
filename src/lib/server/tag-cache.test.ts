import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { TAG_CACHE_BYTES_MAX } from "../constants.js";
import {
  databaseSignature,
  readTagCache,
  tagCachePath,
  writeTagCache,
  TAG_CACHE_VERSION,
  type TagCache,
} from "./tag-cache.js";

let root: string;

const cache = (over: Partial<TagCache> = {}): TagCache => ({
  version: TAG_CACHE_VERSION,
  db: "sig",
  builtAt: new Date().toISOString(),
  scopes: { "*": { hits: [], cardProjects: {} } },
  files: {},
  ...over,
});

beforeEach(() => {
  root = join(tmpdir(), `kozane-tag-cache-test-${randomUUID()}`);
  mkdirSync(join(root, ".kozane"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * The shape `TAG_CACHE_VERSION` is the version *of*, written out by hand.
 *
 * `satisfies` rather than a type annotation, and that is the whole point of it being here: a
 * field added to `TagCache` is missing from this literal and a field removed from it is
 * excess here, and both are compile errors — so the shape cannot change without someone
 * arriving at this line and deciding whether the version has to move with it. The version was
 * a number nothing held to anything: bumping it was a convention, and a build that changed
 * the shape and forgot would read last version's file back as if it were this one's.
 *
 * The value is pinned too, so the diff that changes the shape also shows the bump.
 */
it("pins the shape the cache version is the version of", () => {
  const shape = {
    version: 1,
    db: "ino:mtime:size|",
    builtAt: "2026-01-01T00:00:00.000Z",
    scopes: { "*": { hits: [], cardProjects: {} } },
    files: { "/ws/notes": { "a.md": { signature: "t:1", hits: [] } } },
  } satisfies TagCache;

  expect(TAG_CACHE_VERSION).toBe(shape.version);
  expect(readTagCacheOf(shape)).toEqual(shape);
});

/** Round-trips a cache through the file, which is the only way the validator is reached. */
function readTagCacheOf(value: TagCache): TagCache | null {
  writeTagCache(root, value);
  return readTagCache(root);
}

describe("readTagCache / writeTagCache", () => {
  it("reads back what was written", () => {
    const written = cache({ scopes: { p1: { hits: [], cardProjects: { c1: "p1" } } } });
    writeTagCache(root, written);

    expect(readTagCache(root)).toEqual(written);
  });

  it("answers with nothing when there is no cache file", () => {
    expect(readTagCache(root)).toBeNull();
  });

  /**
   * The read is `readFileSync` and `JSON.parse` on the path a page load waits on, so a cache
   * that has grown past the ceiling is refused *before* it is opened — reading it in order to
   * decide would be the whole of the cost this avoids.
   */
  it("answers with nothing for a cache grown past what is worth reading", () => {
    const padding = "x".repeat(TAG_CACHE_BYTES_MAX);
    writeTagCache(root, cache({ scopes: { "*": { hits: [], cardProjects: { c1: padding } } } }));

    expect(statSync(tagCachePath(root)).size).toBeGreaterThan(TAG_CACHE_BYTES_MAX);
    expect(readTagCache(root)).toBeNull();
  });

  it("answers with nothing for a truncated file rather than throwing", () => {
    writeFileSync(tagCachePath(root), '{"version":1,"db":"sig","sco');

    expect(readTagCache(root)).toBeNull();
  });

  it("answers with nothing for a file this build does not know the shape of", () => {
    writeTagCache(root, cache());
    writeFileSync(tagCachePath(root), JSON.stringify({ ...cache(), version: 999 }));

    expect(readTagCache(root)).toBeNull();
  });

  it("answers with nothing for JSON of the wrong shape", () => {
    writeFileSync(tagCachePath(root), JSON.stringify({ version: TAG_CACHE_VERSION, db: 5 }));

    expect(readTagCache(root)).toBeNull();
  });

  // The shape that used to get through: right at the top, wrong underneath, and dereferenced
  // by `loadTagIndex` the moment it was trusted.
  it("answers with nothing for a scope holding no hits to spread", () => {
    writeFileSync(tagCachePath(root), JSON.stringify(cache({ scopes: { "*": {} } as never })));

    expect(readTagCache(root)).toBeNull();
  });

  it("answers with nothing for a hit that names no source", () => {
    const scopes = { "*": { hits: [{ tag: "perf", excerpt: "" }], cardProjects: {} } };

    writeFileSync(tagCachePath(root), JSON.stringify(cache({ scopes } as never)));

    expect(readTagCache(root)).toBeNull();
  });

  it("answers with nothing for a file entry with no signature to check", () => {
    const files = { "/ws/task": { "a.md": { hits: [] } } };

    writeFileSync(tagCachePath(root), JSON.stringify(cache({ files } as never)));

    expect(readTagCache(root)).toBeNull();
  });

  it("reads back a cache holding real hits of both kinds", () => {
    const written = cache({
      scopes: {
        "*": {
          hits: [
            { tag: "perf", source: { kind: "card", cardId: "c1" }, excerpt: "a" },
            {
              tag: "perf",
              source: { kind: "file", taskspaceId: "t1", path: "a.md", line: 3 },
              excerpt: "b",
            },
          ],
          cardProjects: { c1: "p1" },
        },
      },
      files: {
        "/ws/task": {
          "a.md": { signature: "t:1", hits: [{ tag: "perf", line: 3, excerpt: "b" }] },
        },
      },
    });
    writeTagCache(root, written);

    expect(readTagCache(root)).toEqual(written);
  });

  it("does not throw when the cache cannot be written", () => {
    // No `.kozane` to write into, which is what a workspace mid-deletion looks like.
    const gone = join(tmpdir(), `kozane-tag-cache-missing-${randomUUID()}`);
    expect(() => writeTagCache(gone, cache())).not.toThrow();
  });

  it("replaces a previous cache rather than appending to it", () => {
    writeTagCache(root, cache({ db: "first" }));
    writeTagCache(root, cache({ db: "second" }));

    expect(readTagCache(root)?.db).toBe("second");
  });
});

describe("databaseSignature", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(root, ".kozane", "kozane.db");
    writeFileSync(dbPath, "pretend database");
  });

  it("signs a file: url", () => {
    expect(databaseSignature(`file:${dbPath}`)).toBeTruthy();
  });

  it("signs a bare path too", () => {
    expect(databaseSignature(dbPath)).toBe(databaseSignature(`file:${dbPath}`));
  });

  it("ignores query parameters on the url", () => {
    expect(databaseSignature(`file:${dbPath}?mode=rw`)).toBe(databaseSignature(`file:${dbPath}`));
  });

  it("changes when the database is written", () => {
    const before = databaseSignature(dbPath);
    writeFileSync(dbPath, "pretend database, now longer");

    expect(databaseSignature(dbPath)).not.toBe(before);
  });

  it("changes on a same-length rewrite at a different time", () => {
    const before = databaseSignature(dbPath);
    const later = new Date(Date.now() + 60_000);
    writeFileSync(dbPath, "pretend database"); // same bytes, same length
    utimesSync(dbPath, later, later);

    expect(databaseSignature(dbPath)).not.toBe(before);
  });

  it("changes when a -wal appears beside the database", () => {
    const before = databaseSignature(dbPath);
    writeFileSync(`${dbPath}-wal`, "write-ahead log");

    expect(databaseSignature(dbPath)).not.toBe(before);
  });

  it("has nothing to sign for an in-memory database", () => {
    expect(databaseSignature(":memory:")).toBeNull();
    expect(databaseSignature("file::memory:?cache=shared")).toBeNull();
  });

  it("has nothing to sign for a database that is not there", () => {
    expect(databaseSignature(join(root, "nope.db"))).toBeNull();
  });
});
