import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard, getCard } from "$db/api/card.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { PATCH } from "./+server.js";
import { addLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/cards/partition", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, namespaceId: string, request: Request) {
  return { locals: { db }, params: { namespaceId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  const targetPartitionId = await addPartition({ db, namespaceId, name: "Target" });
  const cardId = await addCard({ db, partitionId, content: "Card" });
  return { db, namespaceId, partitionId, targetPartitionId, cardId };
}

describe("PATCH /[namespaceId]/api/cards/partition", () => {
  it("reassigns cards to a partition in the same namespace", async () => {
    const { db, namespaceId, targetPartitionId, cardId } = await setup();

    const response = await PATCH(
      event(db, namespaceId, jsonRequest({ partitionId: targetPartitionId, cardIds: [cardId] })),
    );

    expect(response.status).toBe(200);
    const card = await getCard({ db, partitionId: targetPartitionId, cardId });
    expect(card).toBeDefined();
  });

  it("rejects a partition that does not belong to the namespace", async () => {
    const { db, namespaceId, cardId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });

    await expectHttpRejection(
      PATCH(
        event(db, namespaceId, jsonRequest({ partitionId: otherPartition, cardIds: [cardId] })),
      ),
      400,
      "Partition not found in namespace",
    );
  });

  it("rejects cards that do not belong to the namespace", async () => {
    const { db, namespaceId, targetPartitionId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Alien" });

    await expectHttpRejection(
      PATCH(
        event(
          db,
          namespaceId,
          jsonRequest({ partitionId: targetPartitionId, cardIds: [foreignCard] }),
        ),
      ),
      400,
      "Some cards do not belong to this namespace",
    );
  });

  it("rejects a missing partitionId", async () => {
    const { db, namespaceId, cardId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ cardIds: [cardId] }))),
      400,
      "partitionId is required",
    );
  });

  it("rejects a missing cardIds", async () => {
    const { db, namespaceId, targetPartitionId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ partitionId: targetPartitionId }))),
      400,
      "cardIds must be an array",
    );
  });
});
