import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard, getCard } from "$db/api/card.js";
import { addLayer } from "$db/api/layer.js";
import { addNamespace } from "$db/api/namespace.js";
import { BATCH_MAX } from "../../../../../lib/constants.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/cards/squash", {
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
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  const cardId = await addCard({
    db,
    partitionId,
    content: "First thought. Second thought",
    posX: 240,
    posY: 120,
  });
  return { db, namespaceId, partitionId, cardId };
}

describe("POST /[namespaceId]/api/cards/squash", () => {
  it("answers with the stored pieces and removes the card", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();

    const response = await POST(event(db, namespaceId, jsonRequest({ cardId })));

    expect(response.status).toBe(200);
    const { cards } = await response.json();
    expect(cards).toEqual([
      expect.objectContaining({ content: "First thought", posX: 240, posY: 120, glueId: null }),
      expect.objectContaining({ content: "Second thought", posX: 520, posY: 120, glueId: null }),
    ]);
    await expect(getCard({ db, partitionId, cardId })).resolves.toBeUndefined();
  });

  it("rejects a card that does not belong to the namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreign = await addCard({ db, partitionId: otherPartition, content: "One. Two" });

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ cardId: foreign }))),
      400,
      "Card not found in namespace",
    );
  });

  it("rejects a card whose text does not split", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "One indivisible thought" });

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ cardId }))),
      400,
      "Card text does not split into more than one card",
    );
  });

  it("rejects a card that splits into more cards than one request may carry", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({
      db,
      partitionId,
      content: Array.from({ length: BATCH_MAX + 1 }, (_, i) => `Piece ${i}`).join(". "),
    });

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ cardId }))),
      400,
      `Card text splits into more than ${BATCH_MAX} cards`,
    );
  });

  it("rejects a missing cardId", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({}))),
      400,
      "cardId is required",
    );
  });
});
