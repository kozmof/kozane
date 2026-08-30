import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createTestDB } from "../../test-utils/db.js";
import { addProject } from "../../db/api/project.js";
import { addBundle } from "../../db/api/bundle.js";
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
    const projectId = await addProject({ db, name: "P" });
    await addLayer({ db, projectId, name: "Base", isDefault: true });
    const bundleId = await addBundle({ db, projectId, name: "B" });
    return { db, projectId, bundleId };
  }

  /** A taskspace directory under the workspace root, with one file in it. `projectId` is
   *  optional because a row belonging to no project is a case this has to cover. */
  async function seedTaskspace(
    db: Awaited<ReturnType<typeof createTestDB>>,
    projectId: string | undefined,
    name: string,
    content: string,
  ) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "notes.md"), content);
    return addTaskspace({ db, projectId, name, path: name });
  }

  it("gathers card tags and file tags into one list", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "on a card 'perf" });
    await seedTaskspace(db, projectId, "notes", "in a file 'docs\n");

    const { hits } = await loadTagIndex({ db, projectId, includeFiles: true, root });

    expect(tags(hits)).toEqual(["docs", "perf"]);
    expect(hits.map(({ source }) => source.kind).sort()).toEqual(["card", "file"]);
  });

  it("leaves files out when it is told to", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "on a card 'perf" });
    await seedTaskspace(db, projectId, "notes", "in a file 'docs\n");

    const { hits } = await loadTagIndex({ db, projectId, includeFiles: false, root });

    expect(tags(hits)).toEqual(["perf"]);
  });

  it("answers about cards alone when there is no workspace root to resolve against", async () => {
    const { db, projectId, bundleId } = await setup();
    await addCard({ db, bundleId, content: "'perf" });

    const { hits } = await loadTagIndex({
      db,
      projectId,
      includeFiles: true,
      root: null,
    });

    expect(tags(hits)).toEqual(["perf"]);
  });

  it("reads a taskspace belonging to no project, which every board draws", async () => {
    const { db, projectId } = await setup();
    await seedTaskspace(db, undefined, "loose", "'unplaced\n");

    const { hits } = await loadTagIndex({ db, projectId, includeFiles: true, root });

    expect(tags(hits)).toEqual(["unplaced"]);
  });

  it("does not read another project's taskspace", async () => {
    const { db, projectId } = await setup();
    const otherProjectId = await addProject({ db, name: "Other" });
    await seedTaskspace(db, otherProjectId, "theirs", "'theirs\n");

    const { hits } = await loadTagIndex({ db, projectId, includeFiles: true, root });

    expect(hits).toEqual([]);
  });

  it("skips a taskspace row with no path", async () => {
    const { db, projectId } = await setup();
    await addTaskspace({ db, projectId, name: "pathless" });

    const { hits, truncated } = await loadTagIndex({
      db,
      projectId,
      includeFiles: true,
      root,
    });

    expect(hits).toEqual([]);
    expect(truncated).toEqual([]);
  });

  it("names the taskspace it could not read in full", async () => {
    const { db, projectId } = await setup();
    const taskspaceId = await seedTaskspace(db, projectId, "notes", "'foo\n");
    rmSync(join(root, "notes"), { recursive: true, force: true });

    const { truncated } = await loadTagIndex({
      db,
      projectId,
      includeFiles: true,
      root,
    });

    // The taskspace root is what could not be listed, so the path naming it is `./` — enough
    // for the reader to tell "this taskspace is gone" from "one file in it is unreadable",
    // which is the distinction the reason alone cannot draw.
    expect(truncated).toEqual([{ taskspaceId, reasons: ["unreadable"], paths: ["./"] }]);
  });

  describe("across the workspace", () => {
    /** A second project with a card and a taskspace of its own. */
    async function addSecondProject(db: Awaited<ReturnType<typeof createTestDB>>) {
      const projectId = await addProject({ db, name: "Other" });
      await addLayer({ db, projectId, name: "Base", isDefault: true });
      const bundleId = await addBundle({ db, projectId, name: "B" });
      await addCard({ db, bundleId, content: "'theirs" });
      await seedTaskspace(db, projectId, "theirs-notes", "'theirs:file\n");
      return { projectId, bundleId };
    }

    it("gathers cards and files from every project when none is named", async () => {
      const { db, projectId, bundleId } = await setup();
      await addCard({ db, bundleId, content: "'mine" });
      await seedTaskspace(db, projectId, "mine-notes", "'mine:file\n");
      await addSecondProject(db);

      const { hits } = await loadTagIndex({ db, includeFiles: true, root });

      expect(tags(hits)).toEqual(["mine", "mine:file", "theirs", "theirs:file"]);
    });

    it("says which project each card and taskspace belongs to", async () => {
      const { db, projectId, bundleId } = await setup();
      const cardId = await addCard({ db, bundleId, content: "'mine" });
      const taskspaceId = await seedTaskspace(db, projectId, "mine-notes", "'mine:file\n");

      const { cardProjects, taskspaces } = await loadTagIndex({
        db,
        includeFiles: true,
        root,
      });

      expect(cardProjects[cardId]).toBe(projectId);
      expect(taskspaces[taskspaceId]).toEqual({ name: "mine-notes", projectId });
    });

    it("reports a taskspace belonging to no project as belonging to none", async () => {
      const { db } = await setup();
      const taskspaceId = await seedTaskspace(db, undefined, "loose", "'unplaced\n");

      const { taskspaces } = await loadTagIndex({ db, includeFiles: true, root });

      expect(taskspaces[taskspaceId]).toEqual({ name: "loose", projectId: null });
    });

    it("names a taskspace it looked at even when it held no tags", async () => {
      const { db, projectId } = await setup();
      const taskspaceId = await seedTaskspace(db, projectId, "empty", "nothing here\n");

      const { taskspaces } = await loadTagIndex({ db, includeFiles: true, root });

      expect(taskspaces).toHaveProperty(taskspaceId);
    });

    /**
     * One budget for the loop, not one per taskspace.
     *
     * There was only the per-taskspace ceiling, so what a gather cost was that ceiling times
     * however many taskspaces a workspace had — unbounded from the page's point of view, and
     * spent inside a synchronous walk that the server does nothing else during. The taskspace
     * that finds the pool empty says so, which is the same promise every other limit here
     * makes: a taskspace half-read is never reported as a taskspace holding no tags.
     */
    it("bounds what one gather costs across every taskspace in it", async () => {
      const { db, projectId } = await setup();
      await seedTaskspace(db, projectId, "a-notes", "'first\n");
      await seedTaskspace(db, projectId, "b-notes", "'second\n");

      const { hits, truncated, taskspaces } = await loadTagIndex({
        db,
        includeFiles: true,
        root,
        // Enough for the first taskspace's file and nothing after it.
        limits: { gather: { workspaceBytes: 8 } },
      });

      expect(tags(hits)).toEqual(["first"]);
      // Named through the record of what was walked, which a truncated taskspace is always
      // in — it was walked, that is how it came to be truncated.
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
      const projectId = await addProject({ db, name: "P" });
      await addLayer({ db, projectId, name: "Base", isDefault: true });
      const bundleId = await addBundle({ db, projectId, name: "B" });
      return { db, projectId, bundleId, cache: { dbUrl } };
    }

    const gather = (db: Awaited<ReturnType<typeof createTestDB>>, cache: TagCacheLocation) =>
      loadTagIndex({ db, includeFiles: true, root, cache });
    type TagCacheLocation = { dbUrl: string };

    it("writes a cache, and does not when it was not asked to", async () => {
      const { db, bundleId } = await cachedSetup();
      await addCard({ db, bundleId, content: "'perf" });

      await loadTagIndex({ db, includeFiles: true, root });
      expect(readTagCache(root)).toBeNull();

      await loadTagIndex({ db, includeFiles: true, root, cache: { dbUrl } });
      expect(readTagCache(root)?.scopes["*"].hits.map(({ tag }) => tag)).toEqual(["perf"]);
    });

    /**
     * Reuse is proved by planting an answer only the cache could give. Rewriting the stored
     * hits and seeing them come back says the card query did not run — where re-querying and
     * getting the same tags would have proved nothing at all.
     */
    it("uses the stored card hits rather than querying again", async () => {
      const { db, bundleId, cache } = await cachedSetup();
      await addCard({ db, bundleId, content: "'perf" });
      await gather(db, cache);

      const planted = readTagCache(root)!;
      planted.scopes["*"] = {
        hits: [{ tag: "planted", source: { kind: "card", cardId: "c1" }, excerpt: "planted" }],
        cardProjects: { c1: "p" },
        truncated: false,
      };
      writeTagCache(root, planted);

      expect(tags((await gather(db, cache)).hits)).toEqual(["planted"]);
    });

    it("re-queries once the database has changed", async () => {
      const { db, bundleId, cache } = await cachedSetup();
      await addCard({ db, bundleId, content: "'perf" });
      await gather(db, cache);

      const planted = readTagCache(root)!;
      planted.scopes["*"] = {
        hits: [{ tag: "planted", source: { kind: "card", cardId: "c1" }, excerpt: "planted" }],
        cardProjects: { c1: "p" },
        truncated: false,
      };
      writeTagCache(root, planted);
      await addCard({ db, bundleId, content: "'second" });

      expect(tags((await gather(db, cache)).hits)).toEqual(["perf", "second"]);
    });

    /** The case a stored build time compared with `>` would wave through, and the reason the
     *  cache stores a signature instead. */
    it("re-queries after an edit that changes neither the card count nor the length", async () => {
      const { db, bundleId, cache } = await cachedSetup();
      const cardId = await addCard({ db, bundleId, content: "'perf" });
      expect(tags((await gather(db, cache)).hits)).toEqual(["perf"]);

      await updateCard({ db, cardId, bundleId, content: "'perg" });

      expect(tags((await gather(db, cache)).hits)).toEqual(["perg"]);
    });

    it("keeps each scope apart", async () => {
      const { db, projectId, bundleId, cache } = await cachedSetup();
      await addCard({ db, bundleId, content: "'perf" });

      await loadTagIndex({ db, includeFiles: true, root, cache });
      await loadTagIndex({ db, projectId, includeFiles: true, root, cache });

      expect(Object.keys(readTagCache(root)!.scopes).sort()).toEqual(["*", projectId].sort());
    });

    /**
     * The cross-process case: a fresh process has an empty in-process file cache, so what it
     * knows about a file it can only have got from disk. Planting an answer proves it came
     * from there rather than from a re-read.
     */
    it("starts a new process warm from the file entries on disk", async () => {
      const { db, projectId, cache } = await cachedSetup();
      await seedTaskspace(db, projectId, "notes", "'ondisk\n");
      await gather(db, cache);

      const planted = readTagCache(root)!;
      const dir = join(root, "notes");
      planted.files[dir]["notes.md"].hits = [{ tag: "planted", line: 1, excerpt: "planted" }];
      writeTagCache(root, planted);
      clearTaskspaceTagCache(); // as a new process would start

      expect(tags((await gather(db, cache)).hits)).toEqual(["planted"]);
    });

    it("re-reads a file that changed since it was stored", async () => {
      const { db, projectId, cache } = await cachedSetup();
      await seedTaskspace(db, projectId, "notes", "'before\n");
      await gather(db, cache);
      clearTaskspaceTagCache();

      const later = new Date(Date.now() + 60_000);
      writeFileSync(join(root, "notes", "notes.md"), "'after\n");
      utimesSync(join(root, "notes", "notes.md"), later, later);

      expect(tags((await gather(db, cache)).hits)).toEqual(["after"]);
    });

    /**
     * The gather that answers entirely from the file it would be rewriting has nothing to
     * write, and writing anyway meant serializing the whole cache and replacing the file with
     * itself on every page load and every `kozane tag` run.
     */
    it("leaves the file alone when the gather learned nothing", async () => {
      const { db, projectId, bundleId, cache } = await cachedSetup();
      await addCard({ db, bundleId, content: "'perf" });
      await seedTaskspace(db, projectId, "notes", "'docs\n");
      await gather(db, cache);

      const before = statSync(tagCachePath(root)).mtimeMs;
      const stamp = readTagCache(root)!.builtAt;
      await gather(db, cache);

      expect(readTagCache(root)!.builtAt).toBe(stamp);
      expect(statSync(tagCachePath(root)).mtimeMs).toBe(before);
    });

    it("writes again as soon as a file under it changes", async () => {
      const { db, projectId, cache } = await cachedSetup();
      await seedTaskspace(db, projectId, "notes", "'before\n");
      await gather(db, cache);
      const stamp = readTagCache(root)!.builtAt;

      const later = new Date(Date.now() + 60_000);
      writeFileSync(join(root, "notes", "notes.md"), "'after\n");
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
      const { db, projectId, cache } = await cachedSetup();
      const taskspaceId = await seedTaskspace(db, projectId, "notes", "'docs\n");
      await gather(db, cache);
      expect(Object.keys(readTagCache(root)!.files)).toEqual([join(root, "notes")]);

      await deleteTaskspace({ db, taskspaceId });
      clearTaskspaceTagCache();
      await gather(db, cache);

      expect(readTagCache(root)!.files).toEqual({});
    });

    /** A gather narrowed to one project has not seen the other projects' taskspaces, so it
     *  must not read their absence from its own list as their deletion. */
    it("keeps another project's stored files when narrowed to one project", async () => {
      const { db, projectId, cache } = await cachedSetup();
      const otherId = await addProject({ db, name: "Other" });
      await seedTaskspace(db, projectId, "mine", "'mine\n");
      await seedTaskspace(db, otherId, "theirs", "'theirs\n");
      await gather(db, cache);

      await loadTagIndex({ db, projectId, includeFiles: true, root, cache });

      expect(Object.keys(readTagCache(root)!.files).sort()).toEqual(
        [join(root, "mine"), join(root, "theirs")].sort(),
      );
    });

    it("rebuilds silently from a corrupt cache file", async () => {
      const { db, bundleId, cache } = await cachedSetup();
      await addCard({ db, bundleId, content: "'perf" });
      await gather(db, cache);
      writeFileSync(tagCachePath(root), "{ not json");

      expect(tags((await gather(db, cache)).hits)).toEqual(["perf"]);
    });

    /** Not json is the easy corruption. This is the one that got through: the top of the file
     *  says everything a reader checked, and the scope under it holds nothing to gather. */
    it("rebuilds from a cache file that is plausible at the top and wrong underneath", async () => {
      const { db, bundleId, cache } = await cachedSetup();
      await addCard({ db, bundleId, content: "'perf" });
      await gather(db, cache);
      const stored = JSON.parse(readFileSync(tagCachePath(root), "utf-8"));
      writeFileSync(tagCachePath(root), JSON.stringify({ ...stored, scopes: { "*": {} } }));

      expect(tags((await gather(db, cache)).hits)).toEqual(["perf"]);
    });

    it("does not cache a database it cannot identify", async () => {
      const { db, bundleId } = await cachedSetup();
      await addCard({ db, bundleId, content: "'perf" });

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
