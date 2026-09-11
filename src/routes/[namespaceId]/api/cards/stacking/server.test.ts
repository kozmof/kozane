import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard, getCard } from "$db/api/card.js";
import { addNamespace } from "$db/api/namespace.js";
import { addLayer } from "$db/api/layer.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { PATCH } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/cards/stacking", {
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
  const { id: layerId } = await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  const lowId = await addCard({ db, partitionId, layerId, content: "Low", zIndex: 1 });
  const midId = await addCard({ db, partitionId, layerId, content: "Mid", zIndex: 2 });
  const highId = await addCard({ db, partitionId, layerId, content: "High", zIndex: 3 });
  return { db, namespaceId, partitionId, layerId, lowId, midId, highId };
}

describe("PATCH /[namespaceId]/api/cards/stacking", () => {
  it("brings a glue group to the front above the rest of the layer, keeping their order", async () => {
    const { db, namespaceId, partitionId, lowId, midId, highId } = await setup();

    const response = await PATCH(
      event(db, namespaceId, jsonRequest({ cardIds: [lowId, midId], direction: "front" })),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.stacking).toEqual(
      expect.arrayContaining([
        { cardId: lowId, zIndex: 4 },
        { cardId: midId, zIndex: 5 },
      ]),
    );
    await expect(getCard({ db, partitionId, cardId: lowId })).resolves.toMatchObject({ zIndex: 4 });
    await expect(getCard({ db, partitionId, cardId: midId })).resolves.toMatchObject({ zIndex: 5 });
    await expect(getCard({ db, partitionId, cardId: highId })).resolves.toMatchObject({
      zIndex: 3,
    });
  });

  it("sends a glue group to the back below the rest of the layer, keeping their order", async () => {
    const { db, namespaceId, partitionId, lowId, midId, highId } = await setup();

    const response = await PATCH(
      event(db, namespaceId, jsonRequest({ cardIds: [midId, highId], direction: "back" })),
    );

    expect(response.status).toBe(200);
    // The floor is 0, not the layer's actual lowest card (`lowId`, 1): zIndex defaults to 0
    // for a card nothing has ever restacked, so "back" always clears that default too.
    await expect(getCard({ db, partitionId, cardId: midId })).resolves.toMatchObject({
      zIndex: -2,
    });
    await expect(getCard({ db, partitionId, cardId: highId })).resolves.toMatchObject({
      zIndex: -1,
    });
    await expect(getCard({ db, partitionId, cardId: lowId })).resolves.toMatchObject({ zIndex: 1 });
  });

  it("restacks each layer separately when a glue group spans more than one", async () => {
    const { db, namespaceId, partitionId, layerId, lowId } = await setup();
    const { id: otherLayerId } = await addLayer({ db, namespaceId, name: "Draft" });
    const otherId = await addCard({
      db,
      partitionId,
      layerId: otherLayerId,
      content: "Other layer",
      zIndex: 10,
    });

    const response = await PATCH(
      event(db, namespaceId, jsonRequest({ cardIds: [lowId, otherId], direction: "front" })),
    );

    expect(response.status).toBe(200);
    // `lowId` clears the base layer's own top (`highId`, zIndex 3); `otherId` clears only
    // its own layer's top (itself, zIndex 10) rather than anything on the base layer.
    await expect(getCard({ db, partitionId, cardId: lowId })).resolves.toMatchObject({ zIndex: 4 });
    await expect(getCard({ db, partitionId, cardId: otherId })).resolves.toMatchObject({
      zIndex: 11,
    });
    expect(layerId).not.toBe(otherLayerId);
  });

  it("rejects cards that do not belong to the namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Alien" });

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ cardIds: [foreignCard], direction: "front" }))),
      400,
      "Some cards do not belong to this namespace",
    );
  });

  it("rejects an invalid direction", async () => {
    const { db, namespaceId, lowId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ cardIds: [lowId], direction: "sideways" }))),
      400,
      'direction must be "front" or "back"',
    );
  });

  it("rejects a missing cardIds", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ direction: "front" }))),
      400,
      "cardIds must be an array",
    );
  });
});
