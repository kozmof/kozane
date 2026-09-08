import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addPartition,
  getPartition,
  getAllPartitions,
  getPartitionCardCounts,
  deletePartition,
  updatePartitionName,
  getDefaultPartition,
} from "./partition.js";
import { addNamespace } from "./namespace.js";
import { addLayer } from "./layer.js";
import { addCard } from "./card.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Test Namespace" });
  return { db, namespaceId };
}

describe("addPartition", () => {
  it("returns a non-empty id", async () => {
    const { db, namespaceId } = await setup();
    const id = await addPartition({ db, namespaceId, name: "General" });
    expect(id).toBeTruthy();
  });

  it("assigns unique ids", async () => {
    const { db, namespaceId } = await setup();
    const id1 = await addPartition({ db, namespaceId, name: "A" });
    const id2 = await addPartition({ db, namespaceId, name: "B" });
    expect(id1).not.toBe(id2);
  });

  it("allows only one default partition per namespace", async () => {
    const { db, namespaceId } = await setup();
    const id = await addPartition({ db, namespaceId, name: "General", isDefault: true });

    await expect(
      addPartition({ db, namespaceId, name: "Second default", isDefault: true }),
    ).rejects.toThrow();

    expect(await getDefaultPartition({ db, namespaceId })).toMatchObject({ id, isDefault: true });
  });

  it("allows different namespaces to each have a default partition", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    const p2 = await addNamespace({ db, name: "P2" });

    await expect(
      Promise.all([
        addPartition({ db, namespaceId: p1, name: "General", isDefault: true }),
        addPartition({ db, namespaceId: p2, name: "General", isDefault: true }),
      ]),
    ).resolves.toHaveLength(2);
  });
});

describe("getPartition", () => {
  it("returns the partition when namespaceId and partitionId match", async () => {
    const { db, namespaceId } = await setup();
    const partitionId = await addPartition({ db, namespaceId, name: "General" });
    const partition = await getPartition({ db, namespaceId, partitionId });
    expect(partition).toEqual({ id: partitionId, namespaceId, name: "General", isDefault: false });
  });

  it("returns undefined for a missing partitionId", async () => {
    const { db, namespaceId } = await setup();
    expect(await getPartition({ db, namespaceId, partitionId: "ghost" })).toBeUndefined();
  });

  it("returns undefined when partitionId belongs to a different namespace", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    const p2 = await addNamespace({ db, name: "P2" });
    const partitionId = await addPartition({ db, namespaceId: p1, name: "Mine" });
    // Asking for that partition under p2 must not return it
    expect(await getPartition({ db, namespaceId: p2, partitionId })).toBeUndefined();
  });
});

describe("getAllPartitions", () => {
  it("returns empty array when namespace has no partitions", async () => {
    const { db, namespaceId } = await setup();
    expect(await getAllPartitions({ db, namespaceId })).toEqual([]);
  });

  it("returns all partitions for the namespace", async () => {
    const { db, namespaceId } = await setup();
    const b1 = await addPartition({ db, namespaceId, name: "Alpha" });
    const b2 = await addPartition({ db, namespaceId, name: "Beta" });
    const partitions = await getAllPartitions({ db, namespaceId });
    expect(partitions.map((b) => b.id)).toEqual(expect.arrayContaining([b1, b2]));
    expect(partitions).toHaveLength(2);
  });

  it("does not return partitions from other namespaces", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    const p2 = await addNamespace({ db, name: "P2" });
    await addPartition({ db, namespaceId: p1, name: "P1 Partition" });
    expect(await getAllPartitions({ db, namespaceId: p2 })).toEqual([]);
  });
});

describe("deletePartition", () => {
  it("removes the partition", async () => {
    const { db, namespaceId } = await setup();
    const partitionId = await addPartition({ db, namespaceId, name: "ToDelete" });
    await deletePartition({ db, namespaceId, partitionId });
    expect(await getPartition({ db, namespaceId, partitionId })).toBeUndefined();
  });

  it("throws NotFoundError for a missing partitionId", async () => {
    const { db, namespaceId } = await setup();
    await expect(deletePartition({ db, namespaceId, partitionId: "ghost" })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("throws NotFoundError when partitionId belongs to a different namespace", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    const p2 = await addNamespace({ db, name: "P2" });
    const partitionId = await addPartition({ db, namespaceId: p1, name: "Mine" });
    await expect(deletePartition({ db, namespaceId: p2, partitionId })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("updatePartitionName", () => {
  it("changes the partition name", async () => {
    const { db, namespaceId } = await setup();
    const partitionId = await addPartition({ db, namespaceId, name: "Old" });
    await updatePartitionName({ db, namespaceId, partitionId, name: "New" });
    const partition = await getPartition({ db, namespaceId, partitionId });
    expect(partition?.name).toBe("New");
  });

  it("throws NotFoundError for a missing partition", async () => {
    const { db, namespaceId } = await setup();
    await expect(
      updatePartitionName({ db, namespaceId, partitionId: "ghost", name: "X" }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("getPartitionCardCounts", () => {
  it("returns nothing for a workspace with no partitions", async () => {
    const db = await createTestDB();
    expect(await getPartitionCardCounts({ db })).toEqual([]);
  });

  /** The whole reason this is a left join. An empty partition is a partition. */
  it("reports a partition holding no cards, at zero", async () => {
    const { db, namespaceId } = await setup();
    const partitionId = await addPartition({ db, namespaceId, name: "Empty" });
    expect(await getPartitionCardCounts({ db })).toEqual([
      { id: partitionId, namespaceId, name: "Empty", isDefault: false, cards: 0 },
    ]);
  });

  it("counts the cards of each partition", async () => {
    const { db, namespaceId } = await setup();
    await addLayer({ db, namespaceId, name: "Base", isDefault: true });
    const busy = await addPartition({ db, namespaceId, name: "Busy" });
    const quiet = await addPartition({ db, namespaceId, name: "Quiet" });
    await addCard({ db, partitionId: busy, content: "one" });
    await addCard({ db, partitionId: busy, content: "two" });
    await addCard({ db, partitionId: quiet, content: "three" });

    const counts = await getPartitionCardCounts({ db });
    expect(Object.fromEntries(counts.map(({ id, cards }) => [id, cards]))).toEqual({
      [busy]: 2,
      [quiet]: 1,
    });
  });

  it("reaches every namespace in the workspace, and says which is which", async () => {
    const db = await createTestDB();
    const p1 = await addNamespace({ db, name: "P1" });
    const p2 = await addNamespace({ db, name: "P2" });
    await addLayer({ db, namespaceId: p1, name: "Base", isDefault: true });
    const b1 = await addPartition({ db, namespaceId: p1, name: "One" });
    const b2 = await addPartition({ db, namespaceId: p2, name: "Two" });
    await addCard({ db, partitionId: b1, content: "a card" });

    const counts = await getPartitionCardCounts({ db });
    expect(counts.map(({ id, namespaceId, cards }) => ({ id, namespaceId, cards }))).toEqual(
      expect.arrayContaining([
        { id: b1, namespaceId: p1, cards: 1 },
        { id: b2, namespaceId: p2, cards: 0 },
      ]),
    );
    expect(counts).toHaveLength(2);
  });
});
