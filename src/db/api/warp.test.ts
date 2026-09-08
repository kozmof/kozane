import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { addWarp, getAllWarps, getAllWorkspaceWarps, deleteWarp } from "./warp.js";
import { addNamespace, deleteNamespace } from "./namespace.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Test Namespace" });
  return { db, namespaceId };
}

describe("addWarp", () => {
  it("returns the stored row", async () => {
    const { db, namespaceId } = await setup();

    const warp = await addWarp({ db, namespaceId, posX: 240, posY: 480 });

    expect(warp).toMatchObject({ namespaceId, posX: 240, posY: 480 });
    expect(warp.id).toEqual(expect.any(String));
  });

  it("rejects a warp on a namespace that does not exist", async () => {
    const db = await createTestDB();

    await expect(addWarp({ db, namespaceId: "missing", posX: 0, posY: 0 })).rejects.toThrow();
  });
});

describe("getAllWarps", () => {
  it("returns the namespace's warps oldest first", async () => {
    const { db, namespaceId } = await setup();
    const first = await addWarp({ db, namespaceId, posX: 0, posY: 0 });
    const second = await addWarp({ db, namespaceId, posX: 100, posY: 100 });
    const third = await addWarp({ db, namespaceId, posX: 200, posY: 200 });

    expect((await getAllWarps({ db, namespaceId })).map(({ id }) => id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("does not return another namespace's warps", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    const mine = await addWarp({ db, namespaceId, posX: 10, posY: 10 });
    await addWarp({ db, namespaceId: otherId, posX: 20, posY: 20 });

    expect(await getAllWarps({ db, namespaceId })).toMatchObject([{ id: mine.id }]);
  });

  it("returns nothing for a namespace without warps", async () => {
    const { db, namespaceId } = await setup();

    expect(await getAllWarps({ db, namespaceId })).toEqual([]);
  });
});

describe("getAllWorkspaceWarps", () => {
  it("returns every namespace's warps, each namespace's oldest first", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    const mineFirst = await addWarp({ db, namespaceId, posX: 0, posY: 0 });
    const theirs = await addWarp({ db, namespaceId: otherId, posX: 20, posY: 20 });
    const mineSecond = await addWarp({ db, namespaceId, posX: 100, posY: 100 });

    const warps = await getAllWorkspaceWarps({ db });

    expect(warps).toHaveLength(3);
    const byNamespace = (id: string) =>
      warps.filter((w) => w.namespaceId === id).map(({ id }) => id);
    expect(byNamespace(namespaceId)).toEqual([mineFirst.id, mineSecond.id]);
    expect(byNamespace(otherId)).toEqual([theirs.id]);
    // Grouped, so a consumer can walk one namespace's warps without re-sorting: each
    // namespace's id starts exactly one run.
    const ids = warps.map((w) => w.namespaceId);
    expect(ids.filter((id, i) => id !== ids[i - 1])).toHaveLength(new Set(ids).size);
  });

  it("returns nothing for a workspace without warps", async () => {
    const { db } = await setup();

    expect(await getAllWorkspaceWarps({ db })).toEqual([]);
  });
});

describe("deleteWarp", () => {
  it("removes only the named warp", async () => {
    const { db, namespaceId } = await setup();
    const first = await addWarp({ db, namespaceId, posX: 0, posY: 0 });
    const second = await addWarp({ db, namespaceId, posX: 100, posY: 100 });

    await deleteWarp({ db, namespaceId, warpId: first.id });

    expect(await getAllWarps({ db, namespaceId })).toMatchObject([{ id: second.id }]);
  });

  it("throws when the warp does not exist", async () => {
    const { db, namespaceId } = await setup();

    await expect(deleteWarp({ db, namespaceId, warpId: "missing" })).rejects.toThrow(NotFoundError);
  });

  it("refuses to delete a warp through another namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    const warp = await addWarp({ db, namespaceId, posX: 0, posY: 0 });

    await expect(deleteWarp({ db, namespaceId: otherId, warpId: warp.id })).rejects.toThrow(
      NotFoundError,
    );
    expect(await getAllWarps({ db, namespaceId })).toMatchObject([{ id: warp.id }]);
  });
});

describe("namespace deletion", () => {
  it("takes the namespace's warps with it", async () => {
    const { db, namespaceId } = await setup();
    await addWarp({ db, namespaceId, posX: 0, posY: 0 });

    await deleteNamespace({ db, namespaceId });

    expect(await getAllWarps({ db, namespaceId })).toEqual([]);
  });
});
