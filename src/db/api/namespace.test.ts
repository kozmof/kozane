import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addNamespace,
  createNamespace,
  getNamespace,
  getAllNamespaces,
  deleteNamespace,
  updateNamespaceName,
  setDefaultNamespace,
} from "./namespace.js";
import { addPartition, getAllPartitions } from "./partition.js";
import { addLayer, getAllLayers } from "./layer.js";
import { addCard } from "./card.js";
import { glueCards } from "./glue.js";
import { glueTable } from "../schema.js";
import { NotFoundError } from "./utils.js";
import { DEFAULT_PARTITION_NAME, DEFAULT_LAYER_NAME, NAME_MAX } from "../../lib/constants.js";
import type { DB } from "../tx.js";

async function db() {
  return createTestDB();
}

/** A namespace holding two cards glued to each other. */
async function namespaceWithGluedCards(d: DB, name: string) {
  const namespaceId = await addNamespace({ db: d, name });
  await addLayer({ db: d, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db: d, namespaceId, name: "B" });
  const cardA = await addCard({ db: d, partitionId, content: "A" });
  const cardB = await addCard({ db: d, partitionId, content: "B" });
  const glueId = await glueCards({ db: d, cardIds: [cardA, cardB] });
  return { namespaceId, glueId };
}

describe("addNamespace", () => {
  it("returns a non-empty id", async () => {
    const d = await db();
    const id = await addNamespace({ db: d, name: "My Namespace" });
    expect(id).toBeTruthy();
  });

  it("assigns unique ids to each namespace", async () => {
    const d = await db();
    const id1 = await addNamespace({ db: d, name: "A" });
    const id2 = await addNamespace({ db: d, name: "B" });
    expect(id1).not.toBe(id2);
  });
});

describe("createNamespace", () => {
  it("returns a non-empty id", async () => {
    const d = await db();
    expect(await createNamespace({ db: d, name: "My Namespace" })).toBeTruthy();
  });

  it("creates the default partition and layer the canvas needs", async () => {
    const d = await db();
    const namespaceId = await createNamespace({ db: d, name: "My Namespace" });

    const partitions = await getAllPartitions({ db: d, namespaceId });
    expect(partitions).toHaveLength(1);
    expect(partitions[0]).toMatchObject({ name: DEFAULT_PARTITION_NAME, isDefault: true });

    const layers = await getAllLayers({ db: d, namespaceId });
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ name: DEFAULT_LAYER_NAME, isDefault: true, position: 0 });
  });

  it("leaves the namespace non-default unless asked", async () => {
    const d = await db();
    const plain = await createNamespace({ db: d, name: "Plain" });
    const flagged = await createNamespace({ db: d, name: "Flagged", isDefault: true });
    expect((await getNamespace({ db: d, namespaceId: plain }))?.isDefault).toBe(false);
    expect((await getNamespace({ db: d, namespaceId: flagged }))?.isDefault).toBe(true);
  });

  it("writes nothing when a name is rejected", async () => {
    const d = await db();
    await expect(createNamespace({ db: d, name: "x".repeat(NAME_MAX + 1) })).rejects.toThrow();
    expect(await getAllNamespaces({ db: d })).toEqual([]);
  });
});

describe("setDefaultNamespace", () => {
  it("changes the only default namespace", async () => {
    const d = await db();
    const first = await addNamespace({ db: d, name: "First", isDefault: true });
    const second = await addNamespace({ db: d, name: "Second" });
    await setDefaultNamespace({ db: d, namespaceId: second });
    expect(await getNamespace({ db: d, namespaceId: first })).toMatchObject({ isDefault: false });
    expect(await getNamespace({ db: d, namespaceId: second })).toMatchObject({ isDefault: true });
  });

  it("throws when the namespace does not exist without clearing the current default", async () => {
    const d = await db();
    const first = await addNamespace({ db: d, name: "First", isDefault: true });
    await expect(setDefaultNamespace({ db: d, namespaceId: "ghost" })).rejects.toThrow(
      NotFoundError,
    );
    expect(await getNamespace({ db: d, namespaceId: first })).toMatchObject({ isDefault: true });
  });
});

describe("getNamespace", () => {
  it("returns the namespace with matching id", async () => {
    const d = await db();
    const id = await addNamespace({ db: d, name: "Test" });
    const namespace = await getNamespace({ db: d, namespaceId: id });
    expect(namespace).toEqual({ id, name: "Test", isDefault: false });
  });

  it("returns undefined for a missing id", async () => {
    const d = await db();
    expect(await getNamespace({ db: d, namespaceId: "no-such-id" })).toBeUndefined();
  });
});

describe("getAllNamespaces", () => {
  it("returns empty array when no namespaces exist", async () => {
    const d = await db();
    expect(await getAllNamespaces({ db: d })).toEqual([]);
  });

  it("returns all created namespaces", async () => {
    const d = await db();
    const id1 = await addNamespace({ db: d, name: "Alpha" });
    const id2 = await addNamespace({ db: d, name: "Beta" });
    const namespaces = await getAllNamespaces({ db: d });
    expect(namespaces.map((p) => p.id)).toEqual(expect.arrayContaining([id1, id2]));
    expect(namespaces).toHaveLength(2);
  });
});

describe("deleteNamespace", () => {
  it("removes the namespace so it can no longer be found", async () => {
    const d = await db();
    const id = await addNamespace({ db: d, name: "ToDelete" });
    await deleteNamespace({ db: d, namespaceId: id });
    expect(await getNamespace({ db: d, namespaceId: id })).toBeUndefined();
  });

  it("promotes another namespace when the default is deleted", async () => {
    const d = await db();
    const first = await addNamespace({ db: d, name: "First", isDefault: true });
    const second = await addNamespace({ db: d, name: "Second" });
    await deleteNamespace({ db: d, namespaceId: first });
    expect(await getNamespace({ db: d, namespaceId: second })).toMatchObject({ isDefault: true });
  });

  it("throws NotFoundError when namespace does not exist", async () => {
    const d = await db();
    await expect(deleteNamespace({ db: d, namespaceId: "ghost" })).rejects.toThrow(NotFoundError);
  });

  it("promotes the oldest survivor when several could replace the default", async () => {
    // Repeated because the bug this guards against is an unordered `limit(1)`: a single run
    // can pick the right row by luck.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const d = await db();
      const first = await addNamespace({ db: d, name: "First", isDefault: true });
      const second = await addNamespace({ db: d, name: "Second" });
      await addNamespace({ db: d, name: "Third" });

      await deleteNamespace({ db: d, namespaceId: first });

      const survivors = await getAllNamespaces({ db: d });
      expect(survivors.find(({ isDefault }) => isDefault)?.id).toBe(second);
    }
  });

  it("removes the glue groups its cards leave behind", async () => {
    const d = await db();
    const { namespaceId } = await namespaceWithGluedCards(d, "Doomed");
    expect(await d.select().from(glueTable)).toHaveLength(1);

    await deleteNamespace({ db: d, namespaceId });

    // The cards cascade away without passing through glue.ts, so nothing else would ever
    // remove the group row they belonged to.
    expect(await d.select().from(glueTable)).toEqual([]);
  });

  it("leaves another namespace's glue groups alone", async () => {
    const d = await db();
    const doomed = await namespaceWithGluedCards(d, "Doomed");
    const kept = await namespaceWithGluedCards(d, "Kept");

    await deleteNamespace({ db: d, namespaceId: doomed.namespaceId });

    expect((await d.select().from(glueTable)).map(({ id }) => id)).toEqual([kept.glueId]);
  });
});

describe("updateNamespaceName", () => {
  it("changes the namespace name", async () => {
    const d = await db();
    const id = await addNamespace({ db: d, name: "Old" });
    await updateNamespaceName({ db: d, namespaceId: id, name: "New" });
    const namespace = await getNamespace({ db: d, namespaceId: id });
    expect(namespace?.name).toBe("New");
  });

  it("throws NotFoundError when namespace does not exist", async () => {
    const d = await db();
    await expect(updateNamespaceName({ db: d, namespaceId: "ghost", name: "X" })).rejects.toThrow(
      NotFoundError,
    );
  });
});
