import { afterEach, describe, expect, it, vi } from "vitest";
import { addProject } from "$db/api/project";
import { addBundle } from "$db/api/bundle";
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
import type { MapBundle, MapScope } from "./+page.server.js";
import { buildTagTree } from "$lib/tag";
import type { TagHit } from "$lib/types";
import { tagBundleIndex, type MapTagCard } from "./lib/graph.js";

/**
 * The loader, which is where every decision the map draws is actually made: which projects
 * are packed, what each rectangle's area comes from, which lines a scope gets, and what the
 * tag graph knows. The page repeats none of it.
 */

type MapData = {
  projectId: string | null;
  projects: { id: string; name: string }[];
  drawn: { id: string; name: string }[];
  bundles: MapBundle[];
  scopes: MapScope[];
  tagHits: TagHit[];
  tagCards: Record<string, MapTagCard | undefined>;
  tag: string | null;
  cardsTruncated: boolean;
  zoomStep: number;
  day: string | null;
  activity: { day: string; bundleId: string; cards: number }[];
};

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  return { db, projectId, bundleId };
}

const run = (db: DB, query = "") =>
  load({
    locals: { db },
    url: new URL(`http://localhost/map${query}`),
  } as never) as Promise<MapData>;

const bundle = (data: MapData, id: string) => data.bundles.find((b) => b.id === id);
const tree = (data: MapData) => buildTagTree(data.tagHits);
const tagBundles = (data: MapData) => tagBundleIndex(data.tagHits, data.tagCards).index;

describe("GET /map", () => {
  it("draws an empty workspace as an empty map rather than failing", async () => {
    const db = await createTestDB();
    const data = await run(db);
    expect(data).toMatchObject({ projects: [], bundles: [], scopes: [], tagHits: [] });
  });

  /** The map and the board are zoomed by the same setting, so a workspace that has tuned its
   *  wheel has tuned both. */
  it("hands over the workspace zoom step", async () => {
    const { db } = await setup();
    expect((await run(db)).zoomStep).toBeGreaterThan(0);
  });

  describe("card change activity", () => {
    it("groups card changes by UTC day and bundle", async () => {
      const { db, bundleId } = await setup();
      const first = await addCard({ db, bundleId, content: "one" });
      const second = await addCard({ db, bundleId, content: "two" });
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
        bundleId,
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
    it("gives each bundle the number of cards its area comes from", async () => {
      const { db, projectId, bundleId } = await setup();
      const quiet = await addBundle({ db, projectId, name: "Quiet" });
      await addCard({ db, bundleId, content: "one" });
      await addCard({ db, bundleId, content: "two" });
      await addCard({ db, bundleId: quiet, content: "three" });

      const data = await run(db);
      expect(bundle(data, bundleId)?.cards).toBe(2);
      expect(bundle(data, quiet)?.cards).toBe(1);
    });

    /** The reason the count query is a left join. An empty bundle is drawn empty, not
     *  dropped. */
    it("keeps a bundle holding nothing", async () => {
      const { db, bundleId } = await setup();
      const data = await run(db);
      expect(bundle(data, bundleId)).toMatchObject({ name: "B", cards: 0 });
    });

    /** A bundle is the same colour here as on its own board, which is what the colours are
     *  for — so they come from the same list, in the same order, the board reads. */
    it("colours a bundle the way its board does", async () => {
      const { db, projectId } = await setup();
      const second = await addBundle({ db, projectId, name: "Second" });
      const data = await run(db);
      expect(bundle(data, second)?.bg).toMatch(/^oklch/);
      expect(bundle(data, second)?.dot).not.toBe(data.bundles[0].dot);
    });

    it("packs every project of the workspace", async () => {
      const { db } = await setup();
      const other = await addProject({ db, name: "Other" });
      await addBundle({ db, projectId: other, name: "Theirs" });

      const data = await run(db);
      expect(data.drawn.map(({ name }) => name).sort()).toEqual(["Other", "P"]);
      expect(data.bundles).toHaveLength(2);
    });
  });

  describe("narrowing to one project", () => {
    it("packs that project alone, and still names the others", async () => {
      const { db, projectId, bundleId } = await setup();
      const other = await addProject({ db, name: "Other" });
      await addBundle({ db, projectId: other, name: "Theirs" });

      const data = await run(db, `?projectId=${projectId}`);
      expect(data.drawn.map(({ id }) => id)).toEqual([projectId]);
      expect(data.bundles.map(({ id }) => id)).toEqual([bundleId]);
      expect(data.projects).toHaveLength(2);
    });

    /** Unchecked, a project id naming nothing narrows every read to nothing and draws as an
     *  empty workspace — a bad link that looks like an empty one. */
    it("refuses a project that does not exist", async () => {
      const { db } = await setup();
      await expect(run(db, "?projectId=ghost")).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("the scope graph", () => {
    it("gives a scope a line to each bundle it reaches, across project lines", async () => {
      const db = await createTestDB();
      const p1 = await addProject({ db, name: "P1" });
      const p2 = await addProject({ db, name: "P2" });
      await addLayer({ db, projectId: p1, name: "Base", isDefault: true });
      await addLayer({ db, projectId: p2, name: "Base", isDefault: true });
      const b1 = await addBundle({ db, projectId: p1, name: "One" });
      const b2 = await addBundle({ db, projectId: p2, name: "Two" });
      const scopeId = await addScope({ db, name: "Shared" });
      await addScopeRel({ db, scopeId, cardId: await addCard({ db, bundleId: b1, content: "a" }) });
      await addScopeRel({ db, scopeId, cardId: await addCard({ db, bundleId: b2, content: "b" }) });

      const [scope] = (await run(db)).scopes;
      expect(scope.name).toBe("Shared");
      expect(scope.spokes.map(({ id }) => id).sort()).toEqual([b1, b2].sort());
      expect(scope.spokes.every(({ kind }) => kind === "bundle")).toBe(true);
    });

    /** A taskspace attaches a scope to a project and to no bundle. Drawn against the project
     *  rectangle, or the scope would vanish from the graph entirely. */
    it("draws a taskspace-only scope against the project", async () => {
      const { db, projectId } = await setup();
      const scopeId = await addScope({ db, name: "Files" });
      await addTaskspace({ db, projectId, scopeId, name: "notes", path: "notes" });

      const [scope] = (await run(db)).scopes;
      expect(scope.spokes).toEqual([{ kind: "project", id: projectId, cards: 0 }]);
    });

    it("does not draw a project line where the scope already reaches a bundle of it", async () => {
      const { db, projectId, bundleId } = await setup();
      const scopeId = await addScope({ db, name: "Both" });
      await addScopeRel({ db, scopeId, cardId: await addCard({ db, bundleId, content: "a" }) });
      await addTaskspace({ db, projectId, scopeId, name: "notes", path: "notes" });

      const [scope] = (await run(db)).scopes;
      expect(scope.spokes).toEqual([{ kind: "bundle", id: bundleId, cards: 1 }]);
    });

    /** A hub attached to nothing says less than leaving it out; `kozane scope list` is where
     *  a workspace's scopes are enumerated. */
    it("leaves out a scope nothing has been put in", async () => {
      const { db } = await setup();
      await addScope({ db, name: "Fresh" });
      expect((await run(db)).scopes).toEqual([]);
    });

    it("leaves out a scope reaching only a project the map is not drawing", async () => {
      const { db, projectId } = await setup();
      const other = await addProject({ db, name: "Other" });
      await addLayer({ db, projectId: other, name: "Base", isDefault: true });
      const theirs = await addBundle({ db, projectId: other, name: "Theirs" });
      const scopeId = await addScope({ db, name: "Elsewhere" });
      await addScopeRel({
        db,
        scopeId,
        cardId: await addCard({ db, bundleId: theirs, content: "a" }),
      });

      expect((await run(db, `?projectId=${projectId}`)).scopes).toEqual([]);
    });
  });

  describe("the tag graph", () => {
    it("spells the tree from the tags written on cards", async () => {
      const { db, bundleId } = await setup();
      await addCard({ db, bundleId, content: "caching work 'perf:cache" });

      const [root] = tree(await run(db));
      expect(root.tag).toBe("perf");
      expect(root.total).toEqual({ cards: 1, files: 0 });
    });

    it("says which bundles a tag reaches, and how many of their cards carry it", async () => {
      const { db, projectId, bundleId } = await setup();
      const other = await addBundle({ db, projectId, name: "Other" });
      await addCard({ db, bundleId, content: "'perf here" });
      await addCard({ db, bundleId, content: "'perf again" });
      await addCard({ db, bundleId: other, content: "'perf over here" });

      expect(tagBundles(await run(db)).perf).toEqual({ [bundleId]: 2, [other]: 1 });
    });

    /** `getCardTagHits` answers with one hit per tag per line, so a card writing a tag twice
     *  is two hits and one card. The graph counts cards, as the tree does. */
    it("counts a card once however many times it writes the tag", async () => {
      const { db, bundleId } = await setup();
      await addCard({ db, bundleId, content: "'perf on this line\nand 'perf on this one" });

      expect(tagBundles(await run(db)).perf).toEqual({ [bundleId]: 1 });
    });

    it("keeps subcategories apart, and leaves rolling them up to the page", async () => {
      const { db, bundleId } = await setup();
      await addCard({ db, bundleId, content: "'perf:cache" });

      const index = tagBundles(await run(db));
      expect(index["perf:cache"]).toEqual({ [bundleId]: 1 });
      expect(index.perf).toBeUndefined();
    });

    it("selects the tag named in the query, normalized", async () => {
      const { db } = await setup();
      expect((await run(db, "?tag=PERF:Cache")).tag).toBe("perf:cache");
      expect((await run(db)).tag).toBeNull();
    });

    it("narrows the tags with the map when a project is named", async () => {
      const { db, projectId } = await setup();
      const other = await addProject({ db, name: "Other" });
      await addLayer({ db, projectId: other, name: "Base", isDefault: true });
      const theirs = await addBundle({ db, projectId: other, name: "Theirs" });
      await addCard({ db, bundleId: theirs, content: "'elsewhere" });

      expect(tree(await run(db, `?projectId=${projectId}`))).toEqual([]);
    });

    it("reports nothing truncated for an ordinary workspace", async () => {
      const { db, bundleId } = await setup();
      await addCard({ db, bundleId, content: "'perf" });

      const data = await run(db);
      expect(tagBundleIndex(data.tagHits, data.tagCards).truncated).toBe(false);
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
    const { db, projectId, bundleId } = await setup();
    const scopeId = await addScope({ db, name: "Release plan" });
    await addScopeRel({ db, scopeId, cardId: await addCard({ db, bundleId, content: "'perf" }) });
    return { db, projectId, bundleId };
  }

  /**
   * A plain export carries no scopes — `loadProjectSnapshot` holds that line for the board
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

  /** The packing and the tags are card and bundle content, which an export publishes by
   *  design. Only the scope graph is held back. */
  it("still carries the packing and the tag tree", async () => {
    const { db } = await withScope();
    const data = await loadUnderSsg(db);
    expect(data.bundles).toHaveLength(1);
    expect(tree(data).map(({ tag }) => tag)).toEqual(["perf"]);
  });

  /** An export has no query string, so it bakes the whole workspace and the browser selects
   *  within it. */
  it("bakes the whole index rather than waiting to be asked for one tag", async () => {
    const { db } = await withScope();
    const data = await loadUnderSsg(db);
    expect(data.tag).toBeNull();
    expect(data.projectId).toBeNull();
    expect(Object.keys(tagBundles(data))).toEqual(["perf"]);
  });
});
