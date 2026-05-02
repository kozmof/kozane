import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { addBundle, getBundle, getAllBundles, deleteBundle, updateBundleName } from "./bundle.js";
import { addProject } from "./project.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Test Project" });
  return { db, projectId };
}

describe("addBundle", () => {
  it("returns a non-empty id", async () => {
    const { db, projectId } = await setup();
    const id = await addBundle({ db, projectId, name: "General" });
    expect(id).toBeTruthy();
  });

  it("assigns unique ids", async () => {
    const { db, projectId } = await setup();
    const id1 = await addBundle({ db, projectId, name: "A" });
    const id2 = await addBundle({ db, projectId, name: "B" });
    expect(id1).not.toBe(id2);
  });
});

describe("getBundle", () => {
  it("returns the bundle when projectId and bundleId match", async () => {
    const { db, projectId } = await setup();
    const bundleId = await addBundle({ db, projectId, name: "General" });
    const bundle = await getBundle({ db, projectId, bundleId });
    expect(bundle).toEqual({ id: bundleId, projectId, name: "General" });
  });

  it("returns undefined for a missing bundleId", async () => {
    const { db, projectId } = await setup();
    expect(await getBundle({ db, projectId, bundleId: "ghost" })).toBeUndefined();
  });

  it("returns undefined when bundleId belongs to a different project", async () => {
    const db = await createTestDB();
    const p1 = await addProject({ db, name: "P1" });
    const p2 = await addProject({ db, name: "P2" });
    const bundleId = await addBundle({ db, projectId: p1, name: "Mine" });
    // Asking for that bundle under p2 must not return it
    expect(await getBundle({ db, projectId: p2, bundleId })).toBeUndefined();
  });
});

describe("getAllBundles", () => {
  it("returns empty array when project has no bundles", async () => {
    const { db, projectId } = await setup();
    expect(await getAllBundles({ db, projectId })).toEqual([]);
  });

  it("returns all bundles for the project", async () => {
    const { db, projectId } = await setup();
    const b1 = await addBundle({ db, projectId, name: "Alpha" });
    const b2 = await addBundle({ db, projectId, name: "Beta" });
    const bundles = await getAllBundles({ db, projectId });
    expect(bundles.map((b) => b.id)).toEqual(expect.arrayContaining([b1, b2]));
    expect(bundles).toHaveLength(2);
  });

  it("does not return bundles from other projects", async () => {
    const db = await createTestDB();
    const p1 = await addProject({ db, name: "P1" });
    const p2 = await addProject({ db, name: "P2" });
    await addBundle({ db, projectId: p1, name: "P1 Bundle" });
    expect(await getAllBundles({ db, projectId: p2 })).toEqual([]);
  });
});

describe("deleteBundle", () => {
  it("removes the bundle", async () => {
    const { db, projectId } = await setup();
    const bundleId = await addBundle({ db, projectId, name: "ToDelete" });
    await deleteBundle({ db, projectId, bundleId });
    expect(await getBundle({ db, projectId, bundleId })).toBeUndefined();
  });

  it("throws NotFoundError for a missing bundleId", async () => {
    const { db, projectId } = await setup();
    await expect(deleteBundle({ db, projectId, bundleId: "ghost" })).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when bundleId belongs to a different project", async () => {
    const db = await createTestDB();
    const p1 = await addProject({ db, name: "P1" });
    const p2 = await addProject({ db, name: "P2" });
    const bundleId = await addBundle({ db, projectId: p1, name: "Mine" });
    await expect(deleteBundle({ db, projectId: p2, bundleId })).rejects.toThrow(NotFoundError);
  });
});

describe("updateBundleName", () => {
  it("changes the bundle name", async () => {
    const { db, projectId } = await setup();
    const bundleId = await addBundle({ db, projectId, name: "Old" });
    await updateBundleName({ db, projectId, bundleId, name: "New" });
    const bundle = await getBundle({ db, projectId, bundleId });
    expect(bundle?.name).toBe("New");
  });

  it("throws NotFoundError for a missing bundle", async () => {
    const { db, projectId } = await setup();
    await expect(updateBundleName({ db, projectId, bundleId: "ghost", name: "X" })).rejects.toThrow(
      NotFoundError,
    );
  });
});
