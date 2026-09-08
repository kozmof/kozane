import { describe, expect, it } from "vitest";
import { addNamespace } from "../../db/api/namespace.js";
import { addPartition } from "../../db/api/partition.js";
import { addLayer } from "../../db/api/layer.js";
import { addCard } from "../../db/api/card.js";
import { addScope } from "../../db/api/scope.js";
import { createTestDB } from "../../test-utils/db.js";
import { shortId } from "./short-id.js";
import type { DB } from "../../db/tx.js";
import {
  loadCards,
  movedCoordinate,
  resolvePartitionId,
  resolveCardGroup,
  resolveLayerId,
  resolveScopeId,
} from "./card-refs.js";

/** A namespace with the default partition and layer `kozane namespace create` gives one. */
async function namespace(db: DB, name: string) {
  const namespaceId = await addNamespace({ db, name });
  const { id: layerId } = await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  return { namespaceId, layerId, partitionId };
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
  it("resolves short ids across the whole workspace, not one namespace", async () => {
    // The property that makes `kozane card namespace` possible: an abbreviation is
    // unambiguous in the set of every card there is, so a prefix resolves here whichever
    // namespace printed it.
    const db = await createTestDB();
    const here = await namespace(db, "Here");
    const there = await namespace(db, "There");
    const mine = await addCard({ db, partitionId: here.partitionId, content: "Mine" });
    const theirs = await addCard({ db, partitionId: there.partitionId, content: "Theirs" });

    const resolved = await resolveCardGroup(db, [shortId(theirs, [mine, theirs])]);

    expect(resolved.cardIds).toEqual([theirs]);
    expect(resolved.namespaceId).toBe(there.namespaceId);
    expect(resolved.allIds).toEqual(expect.arrayContaining([mine, theirs]));
  });

  it("names the namespace of the first card asked for", async () => {
    const db = await createTestDB();
    const here = await namespace(db, "Here");
    const first = await addCard({ db, partitionId: here.partitionId, content: "First" });
    const second = await addCard({ db, partitionId: here.partitionId, content: "Second" });

    expect((await resolveCardGroup(db, [first, second])).namespaceId).toBe(here.namespaceId);
  });

  it("refuses an id that names nothing", async () => {
    const db = await createTestDB();
    await namespace(db, "Here");
    await expect(resolveCardGroup(db, ["nosuchcard"])).rejects.toThrow(/Card/);
  });
});

describe("loadCards", () => {
  it("returns the columns a positioning command needs, and only those", async () => {
    const db = await createTestDB();
    const { partitionId } = await namespace(db, "Here");
    const id = await addCard({ db, partitionId, content: "Alpha", posX: 24, posY: 48 });

    const [row] = await loadCards(db, [id]);

    expect(row).toEqual({ id, content: "Alpha", width: null, posX: 24, posY: 48 });
  });

  it("returns nothing for an empty list", async () => {
    const db = await createTestDB();
    expect(await loadCards(db, [])).toEqual([]);
  });

  it("batches an id list past what one statement will bind", async () => {
    // `card glue --add` expands a selection to whole glue groups, which have no ceiling
    // short of the namespace — so this is asked for more ids than SQLite takes parameters.
    const db = await createTestDB();
    const { partitionId } = await namespace(db, "Here");
    const ids: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      ids.push(await addCard({ db, partitionId, content: `Card ${i}` }));
    }
    // Padded with ids that match nothing, so the list is long without the fixture being.
    const padded = [...ids, ...Array.from({ length: 4_000 }, (_, i) => `absent-${i}`)];

    const rows = await loadCards(db, padded);

    expect(rows.map(({ id }) => id).sort()).toEqual([...ids].sort());
  });
});

describe("resolvePartitionId", () => {
  it("falls back to the namespace's default partition", async () => {
    const db = await createTestDB();
    const { namespaceId, partitionId } = await namespace(db, "Here");
    expect(await resolvePartitionId(db, namespaceId)).toBe(partitionId);
  });

  it("resolves a short id within the namespace", async () => {
    const db = await createTestDB();
    const { namespaceId, partitionId } = await namespace(db, "Here");
    const other = await addPartition({ db, namespaceId, name: "Other" });

    expect(await resolvePartitionId(db, namespaceId, shortId(other, [partitionId, other]))).toBe(
      other,
    );
  });

  it("does not resolve a partition of another namespace", async () => {
    const db = await createTestDB();
    const here = await namespace(db, "Here");
    const there = await namespace(db, "There");

    await expect(resolvePartitionId(db, here.namespaceId, there.partitionId)).rejects.toThrow(
      /Partition/,
    );
  });
});

describe("resolveLayerId", () => {
  it("falls back to the namespace's default layer", async () => {
    const db = await createTestDB();
    const { namespaceId, layerId } = await namespace(db, "Here");
    expect(await resolveLayerId(db, namespaceId)).toBe(layerId);
  });

  it("takes a layer by name, which layers alone among these can be named by", async () => {
    const db = await createTestDB();
    const { namespaceId, layerId } = await namespace(db, "Here");
    const { id: draft } = await addLayer({ db, namespaceId, name: "Draft" });

    expect(await resolveLayerId(db, namespaceId, "Draft")).toBe(draft);
    expect(await resolveLayerId(db, namespaceId, shortId(draft, [layerId, draft]))).toBe(draft);
  });

  it("refuses a layer the namespace does not have", async () => {
    const db = await createTestDB();
    const { namespaceId } = await namespace(db, "Here");
    await expect(resolveLayerId(db, namespaceId, "Nowhere")).rejects.toThrow();
  });
});

describe("resolveScopeId", () => {
  it("resolves a short id across the workspace, since a scope is not a namespace's", async () => {
    const db = await createTestDB();
    const scopeId = await addScope({ db, name: "Scope" });
    expect(await resolveScopeId(db, shortId(scopeId, [scopeId]))).toBe(scopeId);
  });

  it("refuses an id that names nothing", async () => {
    const db = await createTestDB();
    await expect(resolveScopeId(db, "nosuchscope")).rejects.toThrow(/Scope/);
  });
});
