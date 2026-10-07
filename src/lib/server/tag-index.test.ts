import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createTestDB } from "../../test-utils/db.js";
import { addNamespace } from "../../db/api/namespace.js";
import { addPartition } from "../../db/api/partition.js";
import { addLayer } from "../../db/api/layer.js";
import { addCard, updateCard } from "../../db/api/card.js";
import { addTaskspace, deleteTaskspace } from "../../db/api/taskspace.js";
import { clearTaskspaceTagCache } from "./taskspace-tags.js";
import { readTagCache, tagCachePath, writeTagCache } from "./tag-cache.js";
import { loadTagIndex } from "./tag-index.js";

/** The tags found, sorted, so a test says what was gathered rather than in what order. */
const tags = (hits: { tag: string }[]) => hits.map(({ tag }) => tag).sort();

describe("loadTagIndex", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `kozane-tag-index-test-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    clearTaskspaceTagCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function setup() {
    const db = await createTestDB();
    const namespaceId = await addNamespace({ db, name: "P" });
    await addLayer({ db, namespaceId, name: "Base", isDefault: true });
    const partitionId = await addPartition({ db, namespaceId, name: "B" });
    return { db, namespaceId, partitionId };
  }

  /** A taskspace directory under the workspace root, with one file in it. `namespaceId` is
   *  optional because a row belonging to no namespace is a case this has to cover. */
  async function seedTaskspace(
    db: Awaited<ReturnType<typeof createTestDB>>,
    namespaceId: string | undefined,
    name: string,
    content: string,
  ) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "notes.md"), content);
    return addTaskspace({ db, namespaceId, name, path: name });
  }

  it("gathers card tags and file tags into one list", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "on a card :perf" });
    await seedTaskspace(db, namespaceId, "notes", "in a file :docs\n");

    const { hits } = await loadTagIndex({ db, namespaceId, includeFiles: true, root });

    expect(tags(hits)).toEqual(["docs", "perf"]);
    expect(hits.map(({ source }) => source.kind).sort()).toEqual(["card", "file"]);
  });

  it("leaves files out when it is told to", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "on a card :perf" });
    await seedTaskspace(db, namespaceId, "notes", "in a file :docs\n");

    const { hits } = await loadTagIndex({ db, namespaceId, includeFiles: false, root });

    expect(tags(hits)).toEqual(["perf"]);
  });

  it("answers about cards alone when there is no workspace root to resolve against", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: ":perf" });

    const { hits } = await loadTagIndex({
      db,
      namespaceId,
      includeFiles: true,
      root: null,
    });

    expect(tags(hits)).toEqual(["perf"]);
  });

  it("reads a taskspace belonging to no namespace, which every board draws", async () => {
    const { db, namespaceId } = await setup();
    await seedTaskspace(db, undefined, "loose", ":unplaced\n");

    const { hits } = await loadTagIndex({ db, namespaceId, includeFiles: true, root });

    expect(tags(hits)).toEqual(["unplaced"]);
  });

  it("does not read another namespace's taskspace", async () => {
    const { db, namespaceId } = await setup();
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await seedTaskspace(db, otherNamespaceId, "theirs", ":theirs\n");

    const { hits } = await loadTagIndex({ db, namespaceId, includeFiles: true, root });

    expect(hits).toEqual([]);
  });

  it("skips a taskspace row with no path", async () => {
    const { db, namespaceId } = await setup();
    await addTaskspace({ db, namespaceId, name: "pathless" });

    const { hits, truncated } = await loadTagIndex({
      db,
      namespaceId,
      includeFiles: true,
      root,
    });

    expect(hits).toEqual([]);
    expect(truncated).toEqual([]);
  });

  /**
   * Report a missing taskspace separately from an incomplete scan so readers can suggest
   * cleaning up its record.
   */
  it("counts a taskspace whose directory is gone as missing, not truncated", async () => {
    const { db, namespaceId } = await setup();
    const taskspaceId = await seedTaskspace(db, namespaceId, "notes", ":foo\n");
    rmSync(join(root, "notes"), { recursive: true, force: true });

    const { truncated, missing, taskspaces } = await loadTagIndex({
      db,
      namespaceId,
      includeFiles: true,
      root,
    });

    expect(truncated).toEqual([]);
    expect(missing).toEqual([taskspaceId]);
    // Record the taskspace as walked even when it yields no hits so the notice can display
    // its name.
    expect(taskspaces[taskspaceId]?.name).toBe("notes");
  });

  describe("across the workspace", () => {
    /** A second namespace with a card and a taskspace of its own. */
    async function addSecondNamespace(db: Awaited<ReturnType<typeof createTestDB>>) {
      const namespaceId = await addNamespace({ db, name: "Other" });
      await addLayer({ db, namespaceId, name: "Base", isDefault: true });
      const partitionId = await addPartition({ db, namespaceId, name: "B" });
      await addCard({ db, partitionId, content: ":theirs" });
      await seedTaskspace(db, namespaceId, "theirs-notes", ":theirs:file\n");
      return { namespaceId, partitionId };
    }

    it("gathers cards and files from every namespace when none is named", async () => {
      const { db, namespaceId, partitionId } = await setup();
      await addCard({ db, partitionId, content: ":mine" });
      await seedTaskspace(db, namespaceId, "mine-notes", ":mine:file\n");
      await addSecondNamespace(db);

      const { hits } = await loadTagIndex({ db, includeFiles: true, root });

      expect(tags(hits)).toEqual(["mine", "mine:file", "theirs", "theirs:file"]);
    });

    /**
     * Verify that queued callbacks run between synchronous taskspace walks. Yielding only to
     * a resolved promise would not let pending I/O run.
     */
    it("lets other work run between taskspaces", async () => {
      const { db, namespaceId, partitionId } = await setup();
      await addCard({ db, partitionId, content: ":mine" });
      await seedTaskspace(db, namespaceId, "one", ":one:file\n");
      await seedTaskspace(db, namespaceId, "two", ":two:file\n");
      await seedTaskspace(db, namespaceId, "three", ":three:file\n");

      let ranDuringGather = false;
      let finished = false;
      setImmediate(() => {
        ranDuringGather = !finished;
      });

      const { hits } = await loadTagIndex({ db, includeFiles: true, root });
      finished = true;

      expect(ranDuringGather).toBe(true);
      // Yielding must not omit a taskspace from the gather.
      expect(tags(hits)).toEqual(["mine", "one:file", "three:file", "two:file"]);
    });

    it("says which namespace each card and taskspace belongs to", async () => {
      const { db, namespaceId, partitionId } = await setup();
      const cardId = await addCard({ db, partitionId, content: ":mine" });
      const taskspaceId = await seedTaskspace(db, namespaceId, "mine-notes", ":mine:file\n");

      const { cardNamespaces, taskspaces } = await loadTagIndex({
        db,
        includeFiles: true,
        root,
      });

      expect(cardNamespaces[cardId]).toBe(namespaceId);
      expect(taskspaces[taskspaceId]).toEqual({ name: "mine-notes", namespaceId });
    });

    it("reports a taskspace belonging to no namespace as belonging to none", async () => {
      const { db } = await setup();
      const taskspaceId = await seedTaskspace(db, undefined, "loose", ":unplaced\n");

      const { taskspaces } = await loadTagIndex({ db, includeFiles: true, root });

      expect(taskspaces[taskspaceId]).toEqual({ name: "loose", namespaceId: null });
    });

    it("names a taskspace it looked at even when it held no tags", async () => {
      const { db, namespaceId } = await setup();
      const taskspaceId = await seedTaskspace(db, namespaceId, "empty", "nothing here\n");

      const { taskspaces } = await loadTagIndex({ db, includeFiles: true, root });

      expect(taskspaces).toHaveProperty(taskspaceId);
    });

    /**
     * Verify a shared workspace budget in addition to per-taskspace limits. Report when the
     * pool prevents a complete scan.
     */
    it("bounds what one gather costs across every taskspace in it", async () => {
      const { db, namespaceId } = await setup();
      await seedTaskspace(db, namespaceId, "a-notes", ":first\n");
      await seedTaskspace(db, namespaceId, "b-notes", ":second\n");

      const { hits, truncated, taskspaces } = await loadTagIndex({
        db,
        includeFiles: true,
        root,
        // Enough for the first taskspace's file and nothing after it.
        limits: { gather: { workspaceBytes: 8 } },
      });

      expect(tags(hits)).toEqual(["first"]);
      // A truncated taskspace still appears in the record of scanned taskspaces.
      expect(truncated.map(({ taskspaceId }) => taskspaces[taskspaceId]?.name)).toEqual([
        "b-notes",
      ]);
      expect(truncated[0].reasons).toEqual(["budget"]);
    });
  });

  describe("with a persisted cache", () => {
    let dbUrl: string;

    /** A workspace whose database sits where a real one would, so the cache can identify it
     *  by signature the way it does in a live workspace. */
    async function cachedSetup() {
      mkdirSync(join(root, ".kozane"), { recursive: true });
      const dbPath = join(root, ".kozane", "kozane.db");
      dbUrl = `file:${dbPath}`;
      const db = await createTestDB(dbPath);
      const namespaceId = await addNamespace({ db, name: "P" });
      await addLayer({ db, namespaceId, name: "Base", isDefault: true });
      const partitionId = await addPartition({ db, namespaceId, name: "B" });
      return { db, namespaceId, partitionId, cache: { dbUrl } };
    }

    const gather = (db: Awaited<ReturnType<typeof createTestDB>>, cache: TagCacheLocation) =>
      loadTagIndex({ db, includeFiles: true, root, cache });
    type TagCacheLocation = { dbUrl: string };

    it("writes a cache, and does not when it was not asked to", async () => {
      const { db, partitionId } = await cachedSetup();
      await addCard({ db, partitionId, content: ":perf" });

      await loadTagIndex({ db, includeFiles: true, root });
      expect(readTagCache(root)).toBeNull();

      await loadTagIndex({ db, includeFiles: true, root, cache: { dbUrl } });
      expect(readTagCache(root)?.scopes["*"].hits.map(({ tag }) => tag)).toEqual(["perf"]);
    });

    /**
     * Replace cached hits with a unique fixture value to prove reuse rather than an
     * equivalent fresh query.
     */
    it("uses the stored card hits rather than querying again", async () => {
      const { db, partitionId, cache } = await cachedSetup();
      await addCard({ db, partitionId, content: ":perf" });
      await gather(db, cache);

      const planted = readTagCache(root)!;
      planted.scopes["*"] = {
        hits: [{ tag: "planted", source: { kind: "card", cardId: "c1" }, excerpt: "planted" }],
        cardData: { c1: { namespaceId: "p", partitionId: "b", updatedDay: "2026-01-01" } },
        cardNamespaces: { c1: "p" },
        truncated: false,
      };
      writeTagCache(root, planted);

      expect(tags((await gather(db, cache)).hits)).toEqual(["planted"]);
    });

    it("re-queries once the database has changed", async () => {
      const { db, partitionId, cache } = await cachedSetup();
      await addCard({ db, partitionId, content: ":perf" });
      await gather(db, cache);

      const planted = readTagCache(root)!;
      planted.scopes["*"] = {
        hits: [{ tag: "planted", source: { kind: "card", cardId: "c1" }, excerpt: "planted" }],
        cardData: { c1: { namespaceId: "p", partitionId: "b", updatedDay: "2026-01-01" } },
        cardNamespaces: { c1: "p" },
        truncated: false,
      };
      writeTagCache(root, planted);
      await addCard({ db, partitionId, content: ":second" });

      expect(tags((await gather(db, cache)).hits)).toEqual(["perf", "second"]);
    });

    /** The case a stored build time compared with `>` would wave through, and the reason the
     *  cache stores a signature instead. */
    it("re-queries after an edit that changes neither the card count nor the length", async () => {
      const { db, partitionId, cache } = await cachedSetup();
      const cardId = await addCard({ db, partitionId, content: ":perf" });
      expect(tags((await gather(db, cache)).hits)).toEqual(["perf"]);

      await updateCard({ db, cardId, partitionId, content: ":perg" });

      expect(tags((await gather(db, cache)).hits)).toEqual(["perg"]);
    });

    it("keeps each scope apart", async () => {
      const { db, namespaceId, partitionId, cache } = await cachedSetup();
      await addCard({ db, partitionId, content: ":perf" });

      await loadTagIndex({ db, includeFiles: true, root, cache });
      await loadTagIndex({ db, namespaceId, includeFiles: true, root, cache });

      expect(Object.keys(readTagCache(root)!.scopes).sort()).toEqual(["*", namespaceId].sort());
    });

    /** Seed the disk cache to prove a fresh process uses it without rereading the source file. */
    it("starts a new process warm from the file entries on disk", async () => {
      const { db, namespaceId, cache } = await cachedSetup();
      await seedTaskspace(db, namespaceId, "notes", ":ondisk\n");
      await gather(db, cache);

      const planted = readTagCache(root)!;
      const dir = join(root, "notes");
      planted.files[dir]["notes.md"].hits = [{ tag: "planted", line: 1, excerpt: "planted" }];
      writeTagCache(root, planted);
      clearTaskspaceTagCache(); // as a new process would start

      expect(tags((await gather(db, cache)).hits)).toEqual(["planted"]);
    });

    it("re-reads a file that changed since it was stored", async () => {
      const { db, namespaceId, cache } = await cachedSetup();
      await seedTaskspace(db, namespaceId, "notes", ":before\n");
      await gather(db, cache);
      clearTaskspaceTagCache();

      const later = new Date(Date.now() + 60_000);
      writeFileSync(join(root, "notes", "notes.md"), ":after\n");
      utimesSync(join(root, "notes", "notes.md"), later, later);

      expect(tags((await gather(db, cache)).hits)).toEqual(["after"]);
    });

    /**
     * The gather that answers entirely from the file it would be rewriting has nothing to
     * write, and writing anyway meant serializing the whole cache and replacing the file with
     * itself on every page load and every `kozane tag` run.
     */
    it("leaves the file alone when the gather learned nothing", async () => {
      const { db, namespaceId, partitionId, cache } = await cachedSetup();
      await addCard({ db, partitionId, content: ":perf" });
      await seedTaskspace(db, namespaceId, "notes", ":docs\n");
      await gather(db, cache);

      const before = statSync(tagCachePath(root)).mtimeMs;
      const stamp = readTagCache(root)!.builtAt;
      await gather(db, cache);

      expect(readTagCache(root)!.builtAt).toBe(stamp);
      expect(statSync(tagCachePath(root)).mtimeMs).toBe(before);
    });

    it("writes again as soon as a file under it changes", async () => {
      const { db, namespaceId, cache } = await cachedSetup();
      await seedTaskspace(db, namespaceId, "notes", ":before\n");
      await gather(db, cache);
      const stamp = readTagCache(root)!.builtAt;

      const later = new Date(Date.now() + 60_000);
      writeFileSync(join(root, "notes", "notes.md"), ":after\n");
      utimesSync(join(root, "notes", "notes.md"), later, later);
      await gather(db, cache);

      expect(readTagCache(root)!.builtAt).not.toBe(stamp);
      expect(tags((await gather(db, cache)).hits)).toEqual(["after"]);
    });

    /**
     * `files` only ever gained keys, so a taskspace deleted or re-pathed left every file it
     * had parsed in the cache for good. A gather across the whole workspace has seen every
     * taskspace there is, which is what lets it tell one that is gone from one it did not
     * happen to look at.
     */
    it("drops the stored files of a taskspace that is no longer one", async () => {
      const { db, namespaceId, cache } = await cachedSetup();
      const taskspaceId = await seedTaskspace(db, namespaceId, "notes", ":docs\n");
      await gather(db, cache);
      expect(Object.keys(readTagCache(root)!.files)).toEqual([join(root, "notes")]);

      await deleteTaskspace({ db, taskspaceId });
      clearTaskspaceTagCache();
      await gather(db, cache);

      expect(readTagCache(root)!.files).toEqual({});
    });

    /** A gather narrowed to one namespace has not seen the other namespaces' taskspaces, so it
     *  must not read their absence from its own list as their deletion. */
    it("keeps another namespace's stored files when narrowed to one namespace", async () => {
      const { db, namespaceId, cache } = await cachedSetup();
      const otherId = await addNamespace({ db, name: "Other" });
      await seedTaskspace(db, namespaceId, "mine", ":mine\n");
      await seedTaskspace(db, otherId, "theirs", ":theirs\n");
      await gather(db, cache);

      await loadTagIndex({ db, namespaceId, includeFiles: true, root, cache });

      expect(Object.keys(readTagCache(root)!.files).sort()).toEqual(
        [join(root, "mine"), join(root, "theirs")].sort(),
      );
    });

    it("rebuilds silently from a corrupt cache file", async () => {
      const { db, partitionId, cache } = await cachedSetup();
      await addCard({ db, partitionId, content: ":perf" });
      await gather(db, cache);
      writeFileSync(tagCachePath(root), "{ not json");

      expect(tags((await gather(db, cache)).hits)).toEqual(["perf"]);
    });

    /** Reject a valid cache header with malformed scope data. */
    it("rebuilds from a cache file that is plausible at the top and wrong underneath", async () => {
      const { db, partitionId, cache } = await cachedSetup();
      await addCard({ db, partitionId, content: ":perf" });
      await gather(db, cache);
      const stored = JSON.parse(readFileSync(tagCachePath(root), "utf-8"));
      writeFileSync(tagCachePath(root), JSON.stringify({ ...stored, scopes: { "*": {} } }));

      expect(tags((await gather(db, cache)).hits)).toEqual(["perf"]);
    });

    it("does not cache a database it cannot identify", async () => {
      const { db, partitionId } = await cachedSetup();
      await addCard({ db, partitionId, content: ":perf" });

      await loadTagIndex({
        db,
        includeFiles: true,
        root,
        cache: { dbUrl: ":memory:" },
      });

      expect(readTagCache(root)).toBeNull();
    });
  });
});
