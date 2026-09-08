import { afterEach, describe, expect, it, vi } from "vitest";
import { addNamespace } from "$db/api/namespace";
import { addPartition } from "$db/api/partition";
import { addLayer } from "$db/api/layer";
import { addCard } from "$db/api/card";
import { cardTable } from "$db/schema";
import { eq } from "drizzle-orm";
import { addScope } from "$db/api/scope";
import { addScopeRel } from "$db/api/scope-rel";
import { addTaskspace } from "$db/api/taskspace";
import type { DB } from "$db/tx";
import { createTestDB } from "../../test-utils/db.js";
import { load } from "./+page.server.js";
import type { MapPartition, MapScope } from "./+page.server.js";
import { buildTagTree } from "$lib/tag";
import type { TagHit } from "$lib/types";
import { tagPartitionIndex, type MapTagCard } from "./lib/graph.js";

/**
 * The loader, which is where every decision the map draws is actually made: which namespaces
 * are packed, what each rectangle's area comes from, which lines a scope gets, and what the
 * tag graph knows. The page repeats none of it.
 */

type MapData = {
  namespaceId: string | null;
  namespaces: { id: string; name: string }[];
  drawn: { id: string; name: string }[];
  partitions: MapPartition[];
  scopes: MapScope[];
  tagHits: TagHit[];
  tagCards: Record<string, MapTagCard | undefined>;
  tag: string | null;
  cardsTruncated: boolean;
  zoomStep: number;
  day: string | null;
  activity: { day: string; partitionId: string; cards: number }[];
};

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "P" });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "B" });
  return { db, namespaceId, partitionId };
}

const run = (db: DB, query = "") =>
  load({
    locals: { db },
    url: new URL(`http://localhost/map${query}`),
  } as never) as Promise<MapData>;

const partition = (data: MapData, id: string) => data.partitions.find((b) => b.id === id);
const tree = (data: MapData) => buildTagTree(data.tagHits);
const tagPartitions = (data: MapData) => tagPartitionIndex(data.tagHits, data.tagCards).index;

describe("GET /map", () => {
  it("draws an empty workspace as an empty map rather than failing", async () => {
    const db = await createTestDB();
    const data = await run(db);
    expect(data).toMatchObject({ namespaces: [], partitions: [], scopes: [], tagHits: [] });
  });

  /** The map and the board are zoomed by the same setting, so a workspace that has tuned its
   *  wheel has tuned both. */
  it("hands over the workspace zoom step", async () => {
    const { db } = await setup();
    expect((await run(db)).zoomStep).toBeGreaterThan(0);
  });

  describe("card change activity", () => {
    it("groups card changes by UTC day and partition", async () => {
      const { db, partitionId } = await setup();
      const first = await addCard({ db, partitionId, content: "one" });
      const second = await addCard({ db, partitionId, content: "two" });
      await db
        .update(cardTable)
        .set({ updatedAt: new Date("2026-09-05T12:00:00.000Z") })
        .where(eq(cardTable.id, first));
      await db
        .update(cardTable)
        .set({ updatedAt: new Date("2026-09-05T23:59:59.000Z") })
        .where(eq(cardTable.id, second));

      expect((await run(db)).activity).toContainEqual({
        day: "2026-09-05",
        partitionId,
        cards: 2,
      });
    });

    it("accepts a real selected day and rejects an invalid one", async () => {
      const { db } = await setup();
      expect((await run(db, "?day=2026-09-05")).day).toBe("2026-09-05");
      await expect(run(db, "?day=2026-02-29")).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("the packing", () => {
    it("gives each partition the number of cards its area comes from", async () => {
      const { db, namespaceId, partitionId } = await setup();
      const quiet = await addPartition({ db, namespaceId, name: "Quiet" });
      await addCard({ db, partitionId, content: "one" });
      await addCard({ db, partitionId, content: "two" });
      await addCard({ db, partitionId: quiet, content: "three" });

      const data = await run(db);
      expect(partition(data, partitionId)?.cards).toBe(2);
      expect(partition(data, quiet)?.cards).toBe(1);
    });

    /** The reason the count query is a left join. An empty partition is drawn empty, not
     *  dropped. */
    it("keeps a partition holding nothing", async () => {
      const { db, partitionId } = await setup();
      const data = await run(db);
      expect(partition(data, partitionId)).toMatchObject({ name: "B", cards: 0 });
    });

    /** A partition is the same colour here as on its own board, which is what the colours are
     *  for — so they come from the same list, in the same order, the board reads. */
    it("colours a partition the way its board does", async () => {
      const { db, namespaceId } = await setup();
      const second = await addPartition({ db, namespaceId, name: "Second" });
      const data = await run(db);
      expect(partition(data, second)?.bg).toMatch(/^oklch/);
      expect(partition(data, second)?.dot).not.toBe(data.partitions[0].dot);
    });

    it("packs every namespace of the workspace", async () => {
      const { db } = await setup();
      const other = await addNamespace({ db, name: "Other" });
      await addPartition({ db, namespaceId: other, name: "Theirs" });

      const data = await run(db);
      expect(data.drawn.map(({ name }) => name).sort()).toEqual(["Other", "P"]);
      expect(data.partitions).toHaveLength(2);
    });
  });

  describe("narrowing to one namespace", () => {
    it("packs that namespace alone, and still names the others", async () => {
      const { db, namespaceId, partitionId } = await setup();
      const other = await addNamespace({ db, name: "Other" });
      await addPartition({ db, namespaceId: other, name: "Theirs" });

      const data = await run(db, `?namespaceId=${namespaceId}`);
      expect(data.drawn.map(({ id }) => id)).toEqual([namespaceId]);
      expect(data.partitions.map(({ id }) => id)).toEqual([partitionId]);
      expect(data.namespaces).toHaveLength(2);
    });

    /** Unchecked, a namespace id naming nothing narrows every read to nothing and draws as an
     *  empty workspace — a bad link that looks like an empty one. */
    it("refuses a namespace that does not exist", async () => {
      const { db } = await setup();
      await expect(run(db, "?namespaceId=ghost")).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("the scope graph", () => {
    it("gives a scope a line to each partition it reaches, across namespace lines", async () => {
      const db = await createTestDB();
      const p1 = await addNamespace({ db, name: "P1" });
      const p2 = await addNamespace({ db, name: "P2" });
      await addLayer({ db, namespaceId: p1, name: "Base", isDefault: true });
      await addLayer({ db, namespaceId: p2, name: "Base", isDefault: true });
      const b1 = await addPartition({ db, namespaceId: p1, name: "One" });
      const b2 = await addPartition({ db, namespaceId: p2, name: "Two" });
      const scopeId = await addScope({ db, name: "Shared" });
      await addScopeRel({
        db,
        scopeId,
        cardId: await addCard({ db, partitionId: b1, content: "a" }),
      });
      await addScopeRel({
        db,
        scopeId,
        cardId: await addCard({ db, partitionId: b2, content: "b" }),
      });

      const [scope] = (await run(db)).scopes;
      expect(scope.name).toBe("Shared");
      expect(scope.spokes.map(({ id }) => id).sort()).toEqual([b1, b2].sort());
      expect(scope.spokes.every(({ kind }) => kind === "partition")).toBe(true);
    });

    /** A taskspace attaches a scope to a namespace and to no partition. Drawn against the namespace
     *  rectangle, or the scope would vanish from the graph entirely. */
    it("draws a taskspace-only scope against the namespace", async () => {
      const { db, namespaceId } = await setup();
      const scopeId = await addScope({ db, name: "Files" });
      await addTaskspace({ db, namespaceId, scopeId, name: "notes", path: "notes" });

      const [scope] = (await run(db)).scopes;
      expect(scope.spokes).toEqual([{ kind: "namespace", id: namespaceId, cards: 0 }]);
    });

    it("does not draw a namespace line where the scope already reaches a partition of it", async () => {
      const { db, namespaceId, partitionId } = await setup();
      const scopeId = await addScope({ db, name: "Both" });
      await addScopeRel({ db, scopeId, cardId: await addCard({ db, partitionId, content: "a" }) });
      await addTaskspace({ db, namespaceId, scopeId, name: "notes", path: "notes" });

      const [scope] = (await run(db)).scopes;
      expect(scope.spokes).toEqual([{ kind: "partition", id: partitionId, cards: 1 }]);
    });

    /** A hub attached to nothing says less than leaving it out; `kozane scope list` is where
     *  a workspace's scopes are enumerated. */
    it("leaves out a scope nothing has been put in", async () => {
      const { db } = await setup();
      await addScope({ db, name: "Fresh" });
      expect((await run(db)).scopes).toEqual([]);
    });

    it("leaves out a scope reaching only a namespace the map is not drawing", async () => {
      const { db, namespaceId } = await setup();
      const other = await addNamespace({ db, name: "Other" });
      await addLayer({ db, namespaceId: other, name: "Base", isDefault: true });
      const theirs = await addPartition({ db, namespaceId: other, name: "Theirs" });
      const scopeId = await addScope({ db, name: "Elsewhere" });
      await addScopeRel({
        db,
        scopeId,
        cardId: await addCard({ db, partitionId: theirs, content: "a" }),
      });

      expect((await run(db, `?namespaceId=${namespaceId}`)).scopes).toEqual([]);
    });
  });

  describe("the tag graph", () => {
    it("spells the tree from the tags written on cards", async () => {
      const { db, partitionId } = await setup();
      await addCard({ db, partitionId, content: "caching work 'perf:cache" });

      const [root] = tree(await run(db));
      expect(root.tag).toBe("perf");
      expect(root.total).toEqual({ cards: 1, files: 0 });
    });

    it("says which partitions a tag reaches, and how many of their cards carry it", async () => {
      const { db, namespaceId, partitionId } = await setup();
      const other = await addPartition({ db, namespaceId, name: "Other" });
      await addCard({ db, partitionId, content: "'perf here" });
      await addCard({ db, partitionId, content: "'perf again" });
      await addCard({ db, partitionId: other, content: "'perf over here" });

      expect(tagPartitions(await run(db)).perf).toEqual({ [partitionId]: 2, [other]: 1 });
    });

    /** `getCardTagHits` answers with one hit per tag per line, so a card writing a tag twice
     *  is two hits and one card. The graph counts cards, as the tree does. */
    it("counts a card once however many times it writes the tag", async () => {
      const { db, partitionId } = await setup();
      await addCard({ db, partitionId, content: "'perf on this line\nand 'perf on this one" });

      expect(tagPartitions(await run(db)).perf).toEqual({ [partitionId]: 1 });
    });

    it("keeps subcategories apart, and leaves rolling them up to the page", async () => {
      const { db, partitionId } = await setup();
      await addCard({ db, partitionId, content: "'perf:cache" });

      const index = tagPartitions(await run(db));
      expect(index["perf:cache"]).toEqual({ [partitionId]: 1 });
      expect(index.perf).toBeUndefined();
    });

    it("selects the tag named in the query, normalized", async () => {
      const { db } = await setup();
      expect((await run(db, "?tag=PERF:Cache")).tag).toBe("perf:cache");
      expect((await run(db)).tag).toBeNull();
    });

    it("narrows the tags with the map when a namespace is named", async () => {
      const { db, namespaceId } = await setup();
      const other = await addNamespace({ db, name: "Other" });
      await addLayer({ db, namespaceId: other, name: "Base", isDefault: true });
      const theirs = await addPartition({ db, namespaceId: other, name: "Theirs" });
      await addCard({ db, partitionId: theirs, content: "'elsewhere" });

      expect(tree(await run(db, `?namespaceId=${namespaceId}`))).toEqual([]);
    });

    it("reports nothing truncated for an ordinary workspace", async () => {
      const { db, partitionId } = await setup();
      await addCard({ db, partitionId, content: "'perf" });

      const data = await run(db);
      expect(tagPartitionIndex(data.tagHits, data.tagCards).truncated).toBe(false);
      expect(data.cardsTruncated).toBe(false);
    });
  });
});

/**
 * The export path, which reads `KOZANE_SSG` when the module is first evaluated — so it is
 * reached by re-importing the module under that environment rather than by a parameter.
 */
describe("as a static export", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadUnderSsg(db: DB, env: Record<string, string> = {}) {
    vi.stubEnv("KOZANE_SSG", "1");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    const { load: ssgLoad } = await import("./+page.server.js");
    return (await ssgLoad({
      locals: { db },
      url: new URL("http://localhost/map"),
    } as never)) as MapData;
  }

  async function withScope() {
    const { db, namespaceId, partitionId } = await setup();
    const scopeId = await addScope({ db, name: "Release plan" });
    await addScopeRel({
      db,
      scopeId,
      cardId: await addCard({ db, partitionId, content: "'perf" }),
    });
    return { db, namespaceId, partitionId };
  }

  /**
   * A plain export carries no scopes — `loadNamespaceSnapshot` holds that line for the board
   * and `docs/security-matrix.md` states it as a promise about what is published. A map that
   * drew them anyway would be the one page that broke it.
   */
  it("carries no scope at all", async () => {
    const { db } = await withScope();
    expect((await loadUnderSsg(db)).scopes).toEqual([]);
  });

  it("carries them once the export was built to carry scoped things", async () => {
    const { db } = await withScope();
    const data = await loadUnderSsg(db, { KOZANE_SSG_INCLUDE_SCOPED_FILES: "1" });
    expect(data.scopes.map(({ name }) => name)).toEqual(["Release plan"]);
  });

  /** The packing and the tags are card and partition content, which an export publishes by
   *  design. Only the scope graph is held back. */
  it("still carries the packing and the tag tree", async () => {
    const { db } = await withScope();
    const data = await loadUnderSsg(db);
    expect(data.partitions).toHaveLength(1);
    expect(tree(data).map(({ tag }) => tag)).toEqual(["perf"]);
  });

  /** An export has no query string, so it bakes the whole workspace and the browser selects
   *  within it. */
  it("bakes the whole index rather than waiting to be asked for one tag", async () => {
    const { db } = await withScope();
    const data = await loadUnderSsg(db);
    expect(data.tag).toBeNull();
    expect(data.namespaceId).toBeNull();
    expect(Object.keys(tagPartitions(data))).toEqual(["perf"]);
  });
});
