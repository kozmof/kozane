import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addLayer,
  getLayer,
  getAllLayers,
  deleteLayer,
  updateLayerName,
  getDefaultLayer,
} from "./layer.js";
import { addProject } from "./project.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Test Project" });
  return { db, projectId };
}

describe("addLayer", () => {
  it("returns an id and stacks each new layer on top of the previous one", async () => {
    const { db, projectId } = await setup();
    const base = await addLayer({ db, projectId, name: "Base", isDefault: true });
    const draft = await addLayer({ db, projectId, name: "Draft" });
    const notes = await addLayer({ db, projectId, name: "Notes" });

    expect(base).toMatchObject({ position: 0 });
    expect(draft).toMatchObject({ position: 1 });
    expect(notes).toMatchObject({ position: 2 });
    expect(new Set([base.id, draft.id, notes.id]).size).toBe(3);
  });

  it("rejects a duplicate name within a project", async () => {
    const { db, projectId } = await setup();
    await addLayer({ db, projectId, name: "Draft" });
    await expect(addLayer({ db, projectId, name: "Draft" })).rejects.toThrow();
  });

  it("allows only one default layer per project", async () => {
    const { db, projectId } = await setup();
    const { id } = await addLayer({ db, projectId, name: "Base", isDefault: true });

    await expect(addLayer({ db, projectId, name: "Second", isDefault: true })).rejects.toThrow();

    expect(await getDefaultLayer({ db, projectId })).toMatchObject({ id, isDefault: true });
  });

  it("allows different projects to each have a default layer of the same name", async () => {
    const db = await createTestDB();
    const p1 = await addProject({ db, name: "P1" });
    const p2 = await addProject({ db, name: "P2" });

    await expect(
      Promise.all([
        addLayer({ db, projectId: p1, name: "Base", isDefault: true }),
        addLayer({ db, projectId: p2, name: "Base", isDefault: true }),
      ]),
    ).resolves.toHaveLength(2);
  });
});

describe("getAllLayers", () => {
  it("returns a project's layers bottom to top", async () => {
    const { db, projectId } = await setup();
    await addLayer({ db, projectId, name: "Base", isDefault: true });
    await addLayer({ db, projectId, name: "Draft" });

    expect((await getAllLayers({ db, projectId })).map(({ name }) => name)).toEqual([
      "Base",
      "Draft",
    ]);
  });

  it("does not return another project's layers", async () => {
    const db = await createTestDB();
    const p1 = await addProject({ db, name: "P1" });
    const p2 = await addProject({ db, name: "P2" });
    await addLayer({ db, projectId: p1, name: "Mine" });
    await addLayer({ db, projectId: p2, name: "Theirs" });

    expect((await getAllLayers({ db, projectId: p1 })).map(({ name }) => name)).toEqual(["Mine"]);
  });
});

describe("getLayer", () => {
  it("returns the layer when projectId and layerId match", async () => {
    const { db, projectId } = await setup();
    const { id } = await addLayer({ db, projectId, name: "Draft" });

    expect(await getLayer({ db, projectId, layerId: id })).toMatchObject({ id, name: "Draft" });
  });

  it("returns undefined for a layer in another project", async () => {
    const db = await createTestDB();
    const p1 = await addProject({ db, name: "P1" });
    const p2 = await addProject({ db, name: "P2" });
    const { id } = await addLayer({ db, projectId: p2, name: "Theirs" });

    expect(await getLayer({ db, projectId: p1, layerId: id })).toBeUndefined();
  });
});

describe("deleteLayer", () => {
  it("removes the layer", async () => {
    const { db, projectId } = await setup();
    const { id } = await addLayer({ db, projectId, name: "Draft" });

    await deleteLayer({ db, projectId, layerId: id });

    expect(await getAllLayers({ db, projectId })).toEqual([]);
  });

  it("throws NotFoundError for a layer in another project", async () => {
    const db = await createTestDB();
    const p1 = await addProject({ db, name: "P1" });
    const p2 = await addProject({ db, name: "P2" });
    const { id } = await addLayer({ db, projectId: p2, name: "Theirs" });

    await expect(deleteLayer({ db, projectId: p1, layerId: id })).rejects.toThrow(NotFoundError);
  });
});

describe("updateLayerName", () => {
  it("renames the layer", async () => {
    const { db, projectId } = await setup();
    const { id } = await addLayer({ db, projectId, name: "Draft" });

    await updateLayerName({ db, projectId, layerId: id, name: "Final" });

    expect(await getLayer({ db, projectId, layerId: id })).toMatchObject({ name: "Final" });
  });

  it("throws NotFoundError for an unknown layer", async () => {
    const { db, projectId } = await setup();

    await expect(
      updateLayerName({ db, projectId, layerId: "missing", name: "Final" }),
    ).rejects.toThrow(NotFoundError);
  });
});
