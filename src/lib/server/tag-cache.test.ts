import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
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

describe("readTagCache / writeTagCache", () => {
  it("reads back what was written", () => {
    const written = cache({ scopes: { p1: { hits: [], cardProjects: { c1: "p1" } } } });
    writeTagCache(root, written);

    expect(readTagCache(root)).toEqual(written);
  });

  it("answers with nothing when there is no cache file", () => {
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
