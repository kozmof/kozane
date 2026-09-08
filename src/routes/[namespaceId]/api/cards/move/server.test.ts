import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard, getCardPartitionNames } from "$db/api/card.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { POST } from "./+server.js";
import { addLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/src-namespace/api/cards/move", {
    method: "POST",
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
  const srcId = await addNamespace({ db, name: "Source" });
  await addLayer({ db, namespaceId: srcId, name: "Base", isDefault: true });
  const dstId = await addNamespace({ db, name: "Destination" });
  await addLayer({ db, namespaceId: dstId, name: "Base", isDefault: true });
  const srcPartition = await addPartition({
    db,
    namespaceId: srcId,
    name: "General",
    isDefault: true,
  });
  return { db, srcId, dstId, srcPartition };
}

describe("POST /[namespaceId]/api/cards/move", () => {
  it("moves cards to the target namespace and returns ok", async () => {
    const { db, srcId, dstId, srcPartition } = await setup();
    const cardId = await addCard({ db, partitionId: srcPartition, content: "Move me" });

    const response = await POST(
      event(db, srcId, jsonRequest({ cardIds: [cardId], targetNamespaceId: dstId })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    const rows = await getCardPartitionNames({ db, cardIds: [cardId] });
    expect(rows[0].partitionId).not.toBe(srcPartition);
  });

  it("rejects when targetNamespaceId equals the source namespace", async () => {
    const { db, srcId, srcPartition } = await setup();
    const cardId = await addCard({ db, partitionId: srcPartition, content: "Self-move" });

    await expectHttpRejection(
      POST(event(db, srcId, jsonRequest({ cardIds: [cardId], targetNamespaceId: srcId }))),
      400,
      "Target namespace must differ from source",
    );
  });

  it("rejects when cards do not belong to the source namespace", async () => {
    const { db, srcId, dstId } = await setup();
    const otherId = await addNamespace({ db, name: "Third" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Not mine" });

    await expectHttpRejection(
      POST(event(db, srcId, jsonRequest({ cardIds: [foreignCard], targetNamespaceId: dstId }))),
      400,
      "Some cards do not belong to this namespace",
    );
  });

  it("rejects a missing targetNamespaceId", async () => {
    const { db, srcId, srcPartition } = await setup();
    const cardId = await addCard({ db, partitionId: srcPartition, content: "Card" });

    await expectHttpRejection(
      POST(event(db, srcId, jsonRequest({ cardIds: [cardId] }))),
      400,
      "targetNamespaceId is required",
    );
  });

  it("rejects a missing cardIds array", async () => {
    const { db, srcId, dstId } = await setup();

    await expectHttpRejection(
      POST(event(db, srcId, jsonRequest({ targetNamespaceId: dstId }))),
      400,
      "cardIds must be an array",
    );
  });
});
