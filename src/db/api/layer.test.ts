import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addLayer,
  getLayer,
  getAllLayers,
  deleteLayer,
  reorderLayers,
  updateLayerName,
  getDefaultLayer,
} from "./layer.js";
import { addNamespace } from "./namespace.js";
import { NotFoundError } from "./utils.js";
import { NAME_MAX } from "../../lib/constants.js";

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Test Namespace" });
  return { db, namespaceId };
}

describe("addLayer", () => {
  it("returns an id and stacks each new layer on top of the previous one", async () => {
    const { db, namespaceId } = await setup();
    const base = await addLayer({ db, namespaceId, name: "Base", isDefault: true });
    const draft = await addLayer({ db, namespaceId, name: "Draft" });
    const notes = await addLayer({ db, namespaceId, name: "Notes" });

    expect(base).toMatchObject({ position: 0 });
    expect(draft).toMatchObject({ position: 1 });
    expect(notes).toMatchObject({ position: 2 });
    expect(new Set([base.id, draft.id, notes.id]).size).toBe(3);
  });

  it("rejects a duplicate name within a namespace", async () => {
    const { db, namespaceId } = await setup();
    await addLayer({ db, namespaceId, name: "Draft" });
    await expect(addLayer({ db, namespaceId, name: "Draft" })).rejects.toThrow();
  });

  it("allows only one default layer per namespace", async () => {
    const { db, namespaceId } = await setup();
    const { id } = await addLayer({ db, namespaceId, name: "Base", isDefault: true });

    await expect(addLayer({ db, namespaceId, name: "Second", isDefault: true })).rejects.toThrow();

    expect(await getDefaultLayer({ db, namespaceId })).toMatchObject({ id, isDefault: true });
  });

  it("gives concurrent creates distinct positions", async () => {
    const { db, namespaceId } = await setup();
    await addLayer({ db, namespaceId, name: "Base", isDefault: true });

    // Both reads of the current top happen inside their own INSERT, so neither can see a
    // stale maximum and land on the position the other one took.
    const created = await Promise.all([
      addLayer({ db, namespaceId, name: "One" }),
      addLayer({ db, namespaceId, name: "Two" }),
    ]);

    expect(new Set(created.map(({ position }) => position)).size).toBe(2);
    expect((await getAllLayers({ db, namespaceId })).map(({ position }) => position)).toEqual([
      0, 1, 2,
    ]);
  });

  it("rejects a name longer than the shared limit", async () => {
    const { db, namespaceId } = await setup();

    await expect(addLayer({ db, namespaceId, name: "x".repeat(NAME_MAX + 1) })).rejects.toThrow(
      `Layer name must be ${NAME_MAX} characters or fewer`,
    );
  });

  it("allows different namespaces to each have a default layer of the same name", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    const p2 = await addNamespace({ db, name: "P2" });

    await expect(
      Promise.all([
        addLayer({ db, namespaceId: p1, name: "Base", isDefault: true }),
        addLayer({ db, namespaceId: p2, name: "Base", isDefault: true }),
      ]),
    ).resolves.toHaveLength(2);
  });
});

describe("getAllLayers", () => {
  it("returns a namespace's layers bottom to top", async () => {
    const { db, namespaceId } = await setup();
    await addLayer({ db, namespaceId, name: "Base", isDefault: true });
    await addLayer({ db, namespaceId, name: "Draft" });

    expect((await getAllLayers({ db, namespaceId })).map(({ name }) => name)).toEqual([
      "Base",
      "Draft",
    ]);
  });

  it("does not return another namespace's layers", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    const p2 = await addNamespace({ db, name: "P2" });
    await addLayer({ db, namespaceId: p1, name: "Mine" });
    await addLayer({ db, namespaceId: p2, name: "Theirs" });

    expect((await getAllLayers({ db, namespaceId: p1 })).map(({ name }) => name)).toEqual(["Mine"]);
  });
});

describe("getLayer", () => {
  it("returns the layer when namespaceId and layerId match", async () => {
    const { db, namespaceId } = await setup();
    const { id } = await addLayer({ db, namespaceId, name: "Draft" });

    expect(await getLayer({ db, namespaceId, layerId: id })).toMatchObject({ id, name: "Draft" });
  });

  it("returns undefined for a layer in another namespace", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    const p2 = await addNamespace({ db, name: "P2" });
    const { id } = await addLayer({ db, namespaceId: p2, name: "Theirs" });

    expect(await getLayer({ db, namespaceId: p1, layerId: id })).toBeUndefined();
  });
});

describe("deleteLayer", () => {
  it("removes the layer", async () => {
    const { db, namespaceId } = await setup();
    const { id } = await addLayer({ db, namespaceId, name: "Draft" });

    await deleteLayer({ db, namespaceId, layerId: id });

    expect(await getAllLayers({ db, namespaceId })).toEqual([]);
  });

  it("throws NotFoundError for a layer in another namespace", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    const p2 = await addNamespace({ db, name: "P2" });
    const { id } = await addLayer({ db, namespaceId: p2, name: "Theirs" });

    await expect(deleteLayer({ db, namespaceId: p1, layerId: id })).rejects.toThrow(NotFoundError);
  });
});

describe("reorderLayers", () => {
  async function threeLayers() {
    const { db, namespaceId } = await setup();
    const base = await addLayer({ db, namespaceId, name: "Base", isDefault: true });
    const draft = await addLayer({ db, namespaceId, name: "Draft" });
    const notes = await addLayer({ db, namespaceId, name: "Notes" });
    return { db, namespaceId, base: base.id, draft: draft.id, notes: notes.id };
  }

  it("renumbers the layers from the given bottom-to-top ordering", async () => {
    const { db, namespaceId, base, draft, notes } = await threeLayers();

    await expect(
      reorderLayers({ db, namespaceId, layerIds: [notes, base, draft] }),
    ).resolves.toEqual({
      ok: true,
    });

    expect(
      (await getAllLayers({ db, namespaceId })).map(({ name, position }) => [name, position]),
    ).toEqual([
      ["Notes", 0],
      ["Base", 1],
      ["Draft", 2],
    ]);
  });

  it("changes nothing when the ordering omits a layer", async () => {
    const { db, namespaceId, base, draft } = await threeLayers();

    await expect(reorderLayers({ db, namespaceId, layerIds: [draft, base] })).resolves.toEqual({
      ok: false,
      reason: "stale",
    });

    expect((await getAllLayers({ db, namespaceId })).map(({ name }) => name)).toEqual([
      "Base",
      "Draft",
      "Notes",
    ]);
  });

  it("changes nothing when the ordering repeats a layer", async () => {
    const { db, namespaceId, base, draft } = await threeLayers();

    await expect(
      reorderLayers({ db, namespaceId, layerIds: [base, draft, draft] }),
    ).resolves.toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("changes nothing when the ordering names a layer from another namespace", async () => {
    const { db, namespaceId, base, draft } = await threeLayers();
    const otherId = await addNamespace({ db, name: "Other" });
    const foreign = await addLayer({ db, namespaceId: otherId, name: "Theirs" });

    await expect(
      reorderLayers({ db, namespaceId, layerIds: [base, draft, foreign.id] }),
    ).resolves.toEqual({ ok: false, reason: "foreign" });

    expect((await getAllLayers({ db, namespaceId })).map(({ name }) => name)).toEqual([
      "Base",
      "Draft",
      "Notes",
    ]);
  });
});

describe("updateLayerName", () => {
  it("renames the layer", async () => {
    const { db, namespaceId } = await setup();
    const { id } = await addLayer({ db, namespaceId, name: "Draft" });

    await updateLayerName({ db, namespaceId, layerId: id, name: "Final" });

    expect(await getLayer({ db, namespaceId, layerId: id })).toMatchObject({ name: "Final" });
  });

  it("throws NotFoundError for an unknown layer", async () => {
    const { db, namespaceId } = await setup();

    await expect(
      updateLayerName({ db, namespaceId, layerId: "missing", name: "Final" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects a name longer than the shared limit", async () => {
    const { db, namespaceId } = await setup();
    const { id } = await addLayer({ db, namespaceId, name: "Draft" });

    await expect(
      updateLayerName({ db, namespaceId, layerId: id, name: "x".repeat(NAME_MAX + 1) }),
    ).rejects.toThrow(`Layer name must be ${NAME_MAX} characters or fewer`);
    expect(await getLayer({ db, namespaceId, layerId: id })).toMatchObject({ name: "Draft" });
  });
});
