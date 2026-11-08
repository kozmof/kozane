import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  getScopeAreasInNamespace,
  addScopeArea,
  moveScopeArea,
  deleteScopeArea,
} from "./scope-area.js";
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

describe("addScopeArea", () => {
  it("returns the stored row", async () => {
    const { d, namespaceId, scopeId } = await board();
    const area = await addScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    expect(area).toEqual({ id: expect.any(String), namespaceId, scopeId, ...RECT });
  });

  it("adds another frame for a scope that is already framed here", async () => {
    const { d, namespaceId, scopeId } = await board();
    const first = await addScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    const second = await addScopeArea({
      db: d,
      namespaceId,
      scopeId,
      posX: 900,
      posY: 40,
      width: 300,
      height: 300,
    });

    // A scope organised in two places on one board is framed in two places. Nothing here
    // conflicts, so the second draw is an addition rather than a move of the first.
    expect(second.id).not.toBe(first.id);
    expect(await getScopeAreasInNamespace({ db: d, namespaceId })).toHaveLength(2);
  });

  it("lets one scope be framed on two boards at once", async () => {
    const { d, namespaceId: p1, scopeId } = await board();
    const p2 = await addNamespace({ db: d, name: "P2" });

    await addScopeArea({ db: d, namespaceId: p1, scopeId, ...RECT });
    await addScopeArea({ db: d, namespaceId: p2, scopeId, ...RECT, posX: 0 });

    // Scope-area geometry belongs to each namespace.
    expect(await getScopeAreasInNamespace({ db: d, namespaceId: p1 })).toHaveLength(1);
    expect(await getScopeAreasInNamespace({ db: d, namespaceId: p2 })).toHaveLength(1);
  });
});

describe("moveScopeArea", () => {
  it("moves the one frame it names and leaves the scope's others alone", async () => {
    const { d, namespaceId, scopeId } = await board();
    const first = await addScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    const second = await addScopeArea({ db: d, namespaceId, scopeId, ...RECT, posX: 900 });

    const moved = await moveScopeArea({
      db: d,
      namespaceId,
      scopeId,
      areaId: first.id,
      ...RECT,
      posX: 1500,
    });

    expect(moved).toMatchObject({ id: first.id, posX: 1500 });
    const areas = await getScopeAreasInNamespace({ db: d, namespaceId });
    expect(areas.find((a) => a.id === second.id)?.posX).toBe(900);
  });

  it("throws for a frame this namespace does not have", async () => {
    const { d, namespaceId, scopeId } = await board();
    await expect(
      moveScopeArea({ db: d, namespaceId, scopeId, areaId: "ghost", ...RECT }),
    ).rejects.toThrow(NotFoundError);
  });

  it("throws when the frame belongs to another scope", async () => {
    const { d, namespaceId, scopeId } = await board();
    const other = await addScope({ db: d, name: "Other" });
    const area = await addScopeArea({ db: d, namespaceId, scopeId, ...RECT });

    // The scope is part of the access boundary, the same way the namespace is.
    await expect(
      moveScopeArea({ db: d, namespaceId, scopeId: other, areaId: area.id, ...RECT }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("getScopeAreasInNamespace", () => {
  it("returns only this board's frames", async () => {
    const { d, namespaceId: p1, scopeId } = await board();
    const p2 = await addNamespace({ db: d, name: "P2" });
    await addScopeArea({ db: d, namespaceId: p2, scopeId, ...RECT });

    expect(await getScopeAreasInNamespace({ db: d, namespaceId: p1 })).toEqual([]);
  });

  it("is empty for a scope nobody has framed", async () => {
    const { d, namespaceId } = await board();
    expect(await getScopeAreasInNamespace({ db: d, namespaceId })).toEqual([]);
  });
});

describe("deleteScopeArea", () => {
  it("removes the frame it names", async () => {
    const { d, namespaceId, scopeId } = await board();
    const area = await addScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    await deleteScopeArea({ db: d, namespaceId, scopeId, areaId: area.id });
    expect(await getScopeAreasInNamespace({ db: d, namespaceId })).toEqual([]);
  });

  it("leaves the scope's other frames standing", async () => {
    const { d, namespaceId, scopeId } = await board();
    const first = await addScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    const second = await addScopeArea({ db: d, namespaceId, scopeId, ...RECT, posX: 900 });

    await deleteScopeArea({ db: d, namespaceId, scopeId, areaId: first.id });

    // Removing one frame says "not here any more", not "not anywhere".
    const areas = await getScopeAreasInNamespace({ db: d, namespaceId });
    expect(areas.map((a) => a.id)).toEqual([second.id]);
  });

  it("throws when there is no such frame", async () => {
    const { d, namespaceId, scopeId } = await board();
    await expect(deleteScopeArea({ db: d, namespaceId, scopeId, areaId: "ghost" })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("leaves another board's frame alone", async () => {
    const { d, namespaceId: p1, scopeId } = await board();
    const p2 = await addNamespace({ db: d, name: "P2" });
    const mine = await addScopeArea({ db: d, namespaceId: p1, scopeId, ...RECT });
    await addScopeArea({ db: d, namespaceId: p2, scopeId, ...RECT });

    await deleteScopeArea({ db: d, namespaceId: p1, scopeId, areaId: mine.id });

    expect(await getScopeAreasInNamespace({ db: d, namespaceId: p2 })).toHaveLength(1);
  });
});

describe("cascades", () => {
  it("drops the frame when its scope is deleted", async () => {
    const { d, namespaceId, scopeId } = await board();
    await addScopeArea({ db: d, namespaceId, scopeId, ...RECT });

    await deleteScope({ db: d, scopeId });

    expect(await getScopeAreasInNamespace({ db: d, namespaceId })).toEqual([]);
  });

  it("drops the frame when its namespace is deleted", async () => {
    const { d, namespaceId, scopeId } = await board();
    const other = await addNamespace({ db: d, name: "P2" });
    await addScopeArea({ db: d, namespaceId, scopeId, ...RECT });
    await addScopeArea({ db: d, namespaceId: other, scopeId, ...RECT });

    await deleteNamespace({ db: d, namespaceId });

    expect(await getScopeAreasInNamespace({ db: d, namespaceId: other })).toHaveLength(1);
  });
});
