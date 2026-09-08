import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard, getCard } from "$db/api/card.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE, PATCH } from "./+server.js";
import { addLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/cards/card-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, namespaceId: string, cardId: string, request: Request) {
  return { locals: { db }, params: { namespaceId, cardId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  const cardId = await addCard({ db, partitionId, content: "Original" });
  return { db, namespaceId, partitionId, cardId };
}

describe("PATCH /[namespaceId]/api/cards/[cardId]", () => {
  it("updates card content", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();

    const response = await PATCH(
      event(db, namespaceId, cardId, jsonRequest({ content: "  Updated  " })),
    );

    expect(response.status).toBe(200);
    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({
      content: "Updated",
    });
  });

  it("updates card position", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();

    await PATCH(event(db, namespaceId, cardId, jsonRequest({ posX: 48, posY: 72 })));

    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({
      posX: 48,
      posY: 72,
    });
  });

  it("updates card stacking order", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();
    await PATCH(event(db, namespaceId, cardId, jsonRequest({ zIndex: 42 })));
    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({ zIndex: 42 });
  });

  it("rejects a non-integer card stacking order", async () => {
    const { db, namespaceId, cardId } = await setup();
    await expectHttpRejection(
      PATCH(event(db, namespaceId, cardId, jsonRequest({ zIndex: 1.5 }))),
      400,
      "zIndex must be an integer",
    );
  });

  it("updates card width", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();
    await PATCH(event(db, namespaceId, cardId, jsonRequest({ width: 360 })));
    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({ width: 360 });
  });

  it("clears card width when it is sent as null", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();
    await PATCH(event(db, namespaceId, cardId, jsonRequest({ width: 360 })));

    await PATCH(event(db, namespaceId, cardId, jsonRequest({ width: null })));

    // Null is a value here, not an omission: the card goes back to following
    // `ui.defaultCardWidth` rather than keeping the 360 it was just given.
    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({ width: null });
  });

  it("rejects a non-integer card width", async () => {
    const { db, namespaceId, cardId } = await setup();
    await expectHttpRejection(
      PATCH(event(db, namespaceId, cardId, jsonRequest({ width: 210.5 }))),
      400,
      "width must be an integer",
    );
  });

  it("rejects a card width outside the allowed range", async () => {
    const { db, namespaceId, cardId } = await setup();
    await expectHttpRejection(
      PATCH(event(db, namespaceId, cardId, jsonRequest({ width: 39 }))),
      400,
      "width must be between 40 and 1200",
    );
    await expectHttpRejection(
      PATCH(event(db, namespaceId, cardId, jsonRequest({ width: 1201 }))),
      400,
      "width must be between 40 and 1200",
    );
  });

  it("moves card to another partition in the same namespace", async () => {
    const { db, namespaceId, cardId } = await setup();
    const otherPartitionId = await addPartition({ db, namespaceId, name: "Other" });

    await PATCH(event(db, namespaceId, cardId, jsonRequest({ partitionId: otherPartitionId })));

    const card = await getCard({ db, partitionId: otherPartitionId, cardId });
    expect(card).toBeDefined();
  });

  it("rejects blank content", async () => {
    const { db, namespaceId, cardId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, cardId, jsonRequest({ content: "   " }))),
      400,
      "content must not be empty",
    );
  });

  it("rejects a partition from another namespace", async () => {
    const { db, namespaceId, cardId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });

    await expectHttpRejection(
      PATCH(event(db, namespaceId, cardId, jsonRequest({ partitionId: otherPartition }))),
      400,
      "New partition not found in namespace",
    );
  });

  it("rejects a card that does not belong to the namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Alien" });

    await expectHttpRejection(
      PATCH(event(db, namespaceId, foreignCard, jsonRequest({ content: "Nope" }))),
      404,
      "Card not found",
    );
  });

  it("moves the card to another layer of the namespace", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();
    const { id: layerId } = await addLayer({ db, namespaceId, name: "Draft" });

    const response = await PATCH(event(db, namespaceId, cardId, jsonRequest({ layerId })));

    expect(response.status).toBe(200);
    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({ layerId });
  });

  it("rejects a layer from another namespace", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();
    const before = await getCard({ db, partitionId, cardId });
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    const { id: foreignLayer } = await addLayer({
      db,
      namespaceId: otherNamespaceId,
      name: "Theirs",
      isDefault: true,
    });

    await expectHttpRejection(
      PATCH(event(db, namespaceId, cardId, jsonRequest({ layerId: foreignLayer }))),
      400,
      "New layer not found in namespace",
    );
    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({
      layerId: before!.layerId,
    });
  });

  it("rejects a request with no updatable fields", async () => {
    const { db, namespaceId, cardId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, cardId, jsonRequest({}))),
      400,
      "No fields to update",
    );
  });
});

describe("DELETE /[namespaceId]/api/cards/[cardId]", () => {
  it("deletes a card in the namespace", async () => {
    const { db, namespaceId, partitionId, cardId } = await setup();

    const response = await DELETE(event(db, namespaceId, cardId, new Request("http://localhost/")));

    expect(response.status).toBe(200);
    await expect(getCard({ db, partitionId, cardId })).resolves.toBeUndefined();
  });

  it("rejects a card that does not belong to the namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Alien" });

    await expectHttpRejection(
      DELETE(event(db, namespaceId, foreignCard, new Request("http://localhost/"))),
      404,
      "Card not found",
    );
  });
});
