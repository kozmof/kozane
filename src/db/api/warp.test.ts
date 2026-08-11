import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { addWarp, getAllWarps, deleteWarp } from "./warp.js";
import { addProject, deleteProject } from "./project.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Test Project" });
  return { db, projectId };
}

describe("addWarp", () => {
  it("returns the stored row", async () => {
    const { db, projectId } = await setup();

    const warp = await addWarp({ db, projectId, posX: 240, posY: 480 });

    expect(warp).toMatchObject({ projectId, posX: 240, posY: 480 });
    expect(warp.id).toEqual(expect.any(String));
  });

  it("rejects a warp on a project that does not exist", async () => {
    const db = await createTestDB();

    await expect(addWarp({ db, projectId: "missing", posX: 0, posY: 0 })).rejects.toThrow();
  });
});

describe("getAllWarps", () => {
  it("returns the project's warps oldest first", async () => {
    const { db, projectId } = await setup();
    const first = await addWarp({ db, projectId, posX: 0, posY: 0 });
    const second = await addWarp({ db, projectId, posX: 100, posY: 100 });
    const third = await addWarp({ db, projectId, posX: 200, posY: 200 });

    expect((await getAllWarps({ db, projectId })).map(({ id }) => id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("does not return another project's warps", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const mine = await addWarp({ db, projectId, posX: 10, posY: 10 });
    await addWarp({ db, projectId: otherId, posX: 20, posY: 20 });

    expect(await getAllWarps({ db, projectId })).toMatchObject([{ id: mine.id }]);
  });

  it("returns nothing for a project without warps", async () => {
    const { db, projectId } = await setup();

    expect(await getAllWarps({ db, projectId })).toEqual([]);
  });
});

describe("deleteWarp", () => {
  it("removes only the named warp", async () => {
    const { db, projectId } = await setup();
    const first = await addWarp({ db, projectId, posX: 0, posY: 0 });
    const second = await addWarp({ db, projectId, posX: 100, posY: 100 });

    await deleteWarp({ db, projectId, warpId: first.id });

    expect(await getAllWarps({ db, projectId })).toMatchObject([{ id: second.id }]);
  });

  it("throws when the warp does not exist", async () => {
    const { db, projectId } = await setup();

    await expect(deleteWarp({ db, projectId, warpId: "missing" })).rejects.toThrow(NotFoundError);
  });

  it("refuses to delete a warp through another project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const warp = await addWarp({ db, projectId, posX: 0, posY: 0 });

    await expect(deleteWarp({ db, projectId: otherId, warpId: warp.id })).rejects.toThrow(
      NotFoundError,
    );
    expect(await getAllWarps({ db, projectId })).toMatchObject([{ id: warp.id }]);
  });
});

describe("project deletion", () => {
  it("takes the project's warps with it", async () => {
    const { db, projectId } = await setup();
    await addWarp({ db, projectId, posX: 0, posY: 0 });

    await deleteProject({ db, projectId });

    expect(await getAllWarps({ db, projectId })).toEqual([]);
  });
});
