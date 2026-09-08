import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard, getCard } from "$db/api/card.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { PATCH } from "./+server.js";
import { addLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/cards/layer", {
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
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const { id: targetLayerId } = await addLayer({ db, namespaceId, name: "Draft" });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  const cardId = await addCard({ db, partitionId, content: "Card" });
  return { db, namespaceId, partitionId, targetLayerId, cardId };
}

describe("PATCH /[namespaceId]/api/cards/layer", () => {
  it("moves cards to a layer in the same namespace", async () => {
    const { db, namespaceId, partitionId, targetLayerId, cardId } = await setup();

    const response = await PATCH(
      event(db, namespaceId, jsonRequest({ layerId: targetLayerId, cardIds: [cardId] })),
    );

    expect(response.status).toBe(200);
    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({
      layerId: targetLayerId,
    });
  });

  it("rejects a layer that does not belong to the namespace", async () => {
    const { db, namespaceId, cardId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    const { id: foreignLayer } = await addLayer({
      db,
      namespaceId: otherId,
      name: "Base",
      isDefault: true,
    });

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ layerId: foreignLayer, cardIds: [cardId] }))),
      400,
      "Layer not found in namespace",
    );
  });

  it("rejects cards that do not belong to the namespace", async () => {
    const { db, namespaceId, targetLayerId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Alien" });

    await expectHttpRejection(
      PATCH(
        event(db, namespaceId, jsonRequest({ layerId: targetLayerId, cardIds: [foreignCard] })),
      ),
      400,
      "Some cards do not belong to this namespace",
    );
  });

  it("rejects a missing layerId", async () => {
    const { db, namespaceId, cardId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ cardIds: [cardId] }))),
      400,
      "layerId is required",
    );
  });

  it("rejects a missing cardIds", async () => {
    const { db, namespaceId, targetLayerId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ layerId: targetLayerId }))),
      400,
      "cardIds must be an array",
    );
  });
});
