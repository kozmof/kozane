import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { getScopeAreasInNamespace, setScopeArea, deleteScopeArea } from "./scope-area.js";
import { addScope, deleteScope } from "./scope.js";
import { addNamespace, deleteNamespace } from "./namespace.js";
import { addLayer } from "./layer.js";
import { NotFoundError } from "./utils.js";

async function board() {
  const d = await createTestDB();
  const namespaceId = await addNamespace({ db: d, name: "P1" });
  await addLayer({ db: d, namespaceId, name: "Base", isDefault: true });
  const scopeId = await addScope({ db: d, name: "Now" });
  return { d, namespaceId, scopeId };
}

const RECT = { posX: 100, posY: 200, width: 640, height: 480 };

describe("setScopeArea", () => {
  it("returns the stored row", async () => {
    const { d, namespaceId, scopeId } = await board();
    const area = await setScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    expect(area).toEqual({ id: expect.any(String), namespaceId, scopeId, ...RECT });
  });

  it("moves the frame already there rather than adding a second", async () => {
    const { d, namespaceId, scopeId } = await board();
    const first = await setScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    const moved = await setScopeArea({
      db: d,
      namespaceId,
      scopeId,
      posX: 900,
      posY: 40,
      width: 300,
      height: 300,
    });

    // The same row, upserted: a scope has one frame per board, and dragging it is the same
    // write as creating it.
    expect(moved.id).toBe(first.id);
    expect(await getScopeAreasInNamespace({ db: d, namespaceId })).toHaveLength(1);
  });

  it("lets one scope be framed on two boards at once", async () => {
    const { d, namespaceId: p1, scopeId } = await board();
    const p2 = await addNamespace({ db: d, name: "P2" });

    await setScopeArea({ db: d, namespaceId: p1, scopeId, ...RECT });
    await setScopeArea({ db: d, namespaceId: p2, scopeId, ...RECT, posX: 0 });

    // The whole reason geometry is its own table: a scope is cross-namespace, and each
    // board draws it where that board put it.
    expect(await getScopeAreasInNamespace({ db: d, namespaceId: p1 })).toHaveLength(1);
    expect(await getScopeAreasInNamespace({ db: d, namespaceId: p2 })).toHaveLength(1);
  });
});

describe("getScopeAreasInNamespace", () => {
  it("returns only this board's frames", async () => {
    const { d, namespaceId: p1, scopeId } = await board();
    const p2 = await addNamespace({ db: d, name: "P2" });
    await setScopeArea({ db: d, namespaceId: p2, scopeId, ...RECT });

    expect(await getScopeAreasInNamespace({ db: d, namespaceId: p1 })).toEqual([]);
  });

  it("is empty for a scope nobody has framed", async () => {
    const { d, namespaceId } = await board();
    expect(await getScopeAreasInNamespace({ db: d, namespaceId })).toEqual([]);
  });
});

describe("deleteScopeArea", () => {
  it("removes the frame", async () => {
    const { d, namespaceId, scopeId } = await board();
    await setScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    await deleteScopeArea({ db: d, namespaceId, scopeId });
    expect(await getScopeAreasInNamespace({ db: d, namespaceId })).toEqual([]);
  });

  it("throws when there is no frame to remove", async () => {
    const { d, namespaceId, scopeId } = await board();
    await expect(deleteScopeArea({ db: d, namespaceId, scopeId })).rejects.toThrow(NotFoundError);
  });

  it("leaves another board's frame alone", async () => {
    const { d, namespaceId: p1, scopeId } = await board();
    const p2 = await addNamespace({ db: d, name: "P2" });
    await setScopeArea({ db: d, namespaceId: p1, scopeId, ...RECT });
    await setScopeArea({ db: d, namespaceId: p2, scopeId, ...RECT });

    await deleteScopeArea({ db: d, namespaceId: p1, scopeId });

    expect(await getScopeAreasInNamespace({ db: d, namespaceId: p2 })).toHaveLength(1);
  });
});

describe("cascades", () => {
  it("drops the frame when its scope is deleted", async () => {
    const { d, namespaceId, scopeId } = await board();
    await setScopeArea({ db: d, namespaceId, scopeId, ...RECT });

    await deleteScope({ db: d, scopeId });

    expect(await getScopeAreasInNamespace({ db: d, namespaceId })).toEqual([]);
  });

  it("drops the frame when its namespace is deleted", async () => {
    const { d, namespaceId, scopeId } = await board();
    const other = await addNamespace({ db: d, name: "P2" });
    await setScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    await setScopeArea({ db: d, namespaceId: other, scopeId, ...RECT });

    await deleteNamespace({ db: d, namespaceId });

    expect(await getScopeAreasInNamespace({ db: d, namespaceId: other })).toHaveLength(1);
  });
});
