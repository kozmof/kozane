import { describe, expect, it } from "vitest";
import { addPartition, getAllPartitions } from "$db/api/partition.js";
import { addCard, getAllCards } from "$db/api/card.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE, PATCH } from "./+server.js";
import { addLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/partitions/partition-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, namespaceId: string, partitionId: string, request: Request) {
  return { locals: { db }, params: { namespaceId, partitionId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const defaultPartitionId = await addPartition({
    db,
    namespaceId,
    name: "General",
    isDefault: true,
  });
  const partitionId = await addPartition({ db, namespaceId, name: "Extra" });
  return { db, namespaceId, defaultPartitionId, partitionId };
}

describe("PATCH /[namespaceId]/api/partitions/[partitionId]", () => {
  it("renames a partition", async () => {
    const { db, namespaceId, partitionId } = await setup();

    const response = await PATCH(
      event(db, namespaceId, partitionId, jsonRequest({ name: "  Renamed  " })),
    );

    expect(response.status).toBe(200);
    const partitions = await getAllPartitions({ db, namespaceId });
    const updated = partitions.find((b) => b.id === partitionId);
    expect(updated?.name).toBe("Renamed");
  });

  it("rejects a blank name", async () => {
    const { db, namespaceId, partitionId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, partitionId, jsonRequest({ name: "   " }))),
      400,
      "name is required",
    );
  });

  it("rejects a duplicate name within the same namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, partitionId, jsonRequest({ name: "General" }))),
      400,
      'A partition named "General" already exists',
    );
  });

  it("returns 404 for a partition not in the namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });

    await expectHttpRejection(
      PATCH(event(db, namespaceId, otherPartition, jsonRequest({ name: "Hacked" }))),
      404,
      `Partition namespaceId=${namespaceId} partitionId=${otherPartition} not found`,
    );
  });
});

describe("DELETE /[namespaceId]/api/partitions/[partitionId]", () => {
  it("deletes a non-default partition and reassigns its cards to the default", async () => {
    const { db, namespaceId, defaultPartitionId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "Orphan" });

    const response = await DELETE(
      event(db, namespaceId, partitionId, new Request("http://localhost/")),
    );

    expect(response.status).toBe(200);
    const { defaultPartitionId: returned } = await response.json();
    expect(returned).toBe(defaultPartitionId);

    const remaining = await getAllPartitions({ db, namespaceId });
    expect(remaining.find((b) => b.id === partitionId)).toBeUndefined();

    const defaultCards = await getAllCards({ db, partitionId: defaultPartitionId });
    expect(defaultCards).toHaveLength(1);
  });

  it("rejects deleting the default partition", async () => {
    const { db, namespaceId, defaultPartitionId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, namespaceId, defaultPartitionId, new Request("http://localhost/"))),
      400,
      "Cannot delete the default partition",
    );
  });

  it("returns 404 for a partition not in the namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({
      db,
      namespaceId: otherId,
      name: "X",
      isDefault: true,
    });

    await expectHttpRejection(
      DELETE(event(db, namespaceId, otherPartition, new Request("http://localhost/"))),
      404,
      `Partition namespaceId=${namespaceId} partitionId=${otherPartition} not found`,
    );
  });
});
