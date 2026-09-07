import { describe, expect, it } from "vitest";
import { addProject } from "../../db/api/project.js";
import { addBundle } from "../../db/api/bundle.js";
import { addLayer } from "../../db/api/layer.js";
import { addCard } from "../../db/api/card.js";
import { addScope } from "../../db/api/scope.js";
import { createTestDB } from "../../test-utils/db.js";
import { shortId } from "./short-id.js";
import type { DB } from "../../db/tx.js";
import {
  loadCards,
  movedCoordinate,
  resolveBundleId,
  resolveCardGroup,
  resolveLayerId,
  resolveScopeId,
} from "./card-refs.js";

/** A project with the default bundle and layer `kozane project create` gives one. */
async function project(db: DB, name: string) {
  const projectId = await addProject({ db, name });
  const { id: layerId } = await addLayer({ db, projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  return { projectId, layerId, bundleId };
}

describe("movedCoordinate", () => {
  it("takes an absolute position as it stands", () => {
    expect(movedCoordinate(240, 10)).toBe(240);
    expect(movedCoordinate(0, 10)).toBe(0);
    expect(movedCoordinate(-40, 10)).toBe(-40);
  });

  it("reads a relative position against where the card is", () => {
    expect(movedCoordinate("current+100", 240)).toBe(340);
    expect(movedCoordinate("current-100", 240)).toBe(140);
    expect(movedCoordinate("current+0", 240)).toBe(240);
  });

  it("refuses anything else rather than guessing at it", () => {
    for (const value of ["current", "current+", "+100", "current*2", "currentx+1", ""]) {
      expect(() => movedCoordinate(value, 0)).toThrow(/Invalid card position/);
    }
  });
});

describe("resolveCardGroup", () => {
  it("resolves short ids across the whole workspace, not one project", async () => {
    // The property that makes `kozane card project` possible: an abbreviation is
    // unambiguous in the set of every card there is, so a prefix resolves here whichever
    // project printed it.
    const db = await createTestDB();
    const here = await project(db, "Here");
    const there = await project(db, "There");
    const mine = await addCard({ db, bundleId: here.bundleId, content: "Mine" });
    const theirs = await addCard({ db, bundleId: there.bundleId, content: "Theirs" });

    const resolved = await resolveCardGroup(db, [shortId(theirs, [mine, theirs])]);

    expect(resolved.cardIds).toEqual([theirs]);
    expect(resolved.projectId).toBe(there.projectId);
    expect(resolved.allIds).toEqual(expect.arrayContaining([mine, theirs]));
  });

  it("names the project of the first card asked for", async () => {
    const db = await createTestDB();
    const here = await project(db, "Here");
    const first = await addCard({ db, bundleId: here.bundleId, content: "First" });
    const second = await addCard({ db, bundleId: here.bundleId, content: "Second" });

    expect((await resolveCardGroup(db, [first, second])).projectId).toBe(here.projectId);
  });

  it("refuses an id that names nothing", async () => {
    const db = await createTestDB();
    await project(db, "Here");
    await expect(resolveCardGroup(db, ["nosuchcard"])).rejects.toThrow(/Card/);
  });
});

describe("loadCards", () => {
  it("returns the columns a positioning command needs, and only those", async () => {
    const db = await createTestDB();
    const { bundleId } = await project(db, "Here");
    const id = await addCard({ db, bundleId, content: "Alpha", posX: 24, posY: 48 });

    const [row] = await loadCards(db, [id]);

    expect(row).toEqual({ id, content: "Alpha", width: null, posX: 24, posY: 48 });
  });

  it("returns nothing for an empty list", async () => {
    const db = await createTestDB();
    expect(await loadCards(db, [])).toEqual([]);
  });

  it("batches an id list past what one statement will bind", async () => {
    // `card glue --add` expands a selection to whole glue groups, which have no ceiling
    // short of the project — so this is asked for more ids than SQLite takes parameters.
    const db = await createTestDB();
    const { bundleId } = await project(db, "Here");
    const ids: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      ids.push(await addCard({ db, bundleId, content: `Card ${i}` }));
    }
    // Padded with ids that match nothing, so the list is long without the fixture being.
    const padded = [...ids, ...Array.from({ length: 4_000 }, (_, i) => `absent-${i}`)];

    const rows = await loadCards(db, padded);

    expect(rows.map(({ id }) => id).sort()).toEqual([...ids].sort());
  });
});

describe("resolveBundleId", () => {
  it("falls back to the project's default bundle", async () => {
    const db = await createTestDB();
    const { projectId, bundleId } = await project(db, "Here");
    expect(await resolveBundleId(db, projectId)).toBe(bundleId);
  });

  it("resolves a short id within the project", async () => {
    const db = await createTestDB();
    const { projectId, bundleId } = await project(db, "Here");
    const other = await addBundle({ db, projectId, name: "Other" });

    expect(await resolveBundleId(db, projectId, shortId(other, [bundleId, other]))).toBe(other);
  });

  it("does not resolve a bundle of another project", async () => {
    const db = await createTestDB();
    const here = await project(db, "Here");
    const there = await project(db, "There");

    await expect(resolveBundleId(db, here.projectId, there.bundleId)).rejects.toThrow(/Bundle/);
  });
});

describe("resolveLayerId", () => {
  it("falls back to the project's default layer", async () => {
    const db = await createTestDB();
    const { projectId, layerId } = await project(db, "Here");
    expect(await resolveLayerId(db, projectId)).toBe(layerId);
  });

  it("takes a layer by name, which layers alone among these can be named by", async () => {
    const db = await createTestDB();
    const { projectId, layerId } = await project(db, "Here");
    const { id: draft } = await addLayer({ db, projectId, name: "Draft" });

    expect(await resolveLayerId(db, projectId, "Draft")).toBe(draft);
    expect(await resolveLayerId(db, projectId, shortId(draft, [layerId, draft]))).toBe(draft);
  });

  it("refuses a layer the project does not have", async () => {
    const db = await createTestDB();
    const { projectId } = await project(db, "Here");
    await expect(resolveLayerId(db, projectId, "Nowhere")).rejects.toThrow();
  });
});

describe("resolveScopeId", () => {
  it("resolves a short id across the workspace, since a scope is not a project's", async () => {
    const db = await createTestDB();
    const scopeId = await addScope({ db, name: "Scope" });
    expect(await resolveScopeId(db, shortId(scopeId, [scopeId]))).toBe(scopeId);
  });

  it("refuses an id that names nothing", async () => {
    const db = await createTestDB();
    await expect(resolveScopeId(db, "nosuchscope")).rejects.toThrow(/Scope/);
  });
});
