import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard, getCard, getAllCards } from "$db/api/card.js";
import { addNamespace } from "$db/api/namespace.js";
import { addScope } from "$db/api/scope.js";
import { getScopeRelsByCards } from "$db/api/scope-rel.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { DELETE, PATCH, POST } from "./+server.js";
import { addLayer, getDefaultLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, namespaceId: string, request: Request) {
  return {
    locals: { db },
    params: { namespaceId },
    request,
  } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  return { db, namespaceId, partitionId };
}

describe("POST /[namespaceId]/api/cards", () => {
  it("creates a trimmed card in a namespace partition", async () => {
    const { db, namespaceId, partitionId } = await setup();

    const response = await POST(
      event(
        db,
        namespaceId,
        jsonRequest({ partitionId, content: "  New card  ", posX: 24, posY: 48 }),
      ),
    );

    expect(response.status).toBe(200);
    const { id } = await response.json();
    await expect(getCard({ db, partitionId, cardId: id })).resolves.toMatchObject({
      content: "New card",
      posX: 24,
      posY: 48,
    });
  });

  it("puts a card on the namespace's default layer when none is requested", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const defaultLayer = await getDefaultLayer({ db, namespaceId });

    const response = await POST(
      event(db, namespaceId, jsonRequest({ partitionId, content: "Unlayered" })),
    );

    expect(await response.json()).toMatchObject({ layerId: defaultLayer!.id });
  });

  it("puts a card on the requested layer", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const { id: layerId } = await addLayer({ db, namespaceId, name: "Draft" });

    const response = await POST(
      event(db, namespaceId, jsonRequest({ partitionId, content: "Layered", layerId })),
    );

    const { id } = await response.json();
    await expect(getCard({ db, partitionId, cardId: id })).resolves.toMatchObject({ layerId });
  });

  it("rejects a layer from another namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    const { id: foreignLayer } = await addLayer({ db, namespaceId: otherId, name: "Theirs" });

    await expectHttpRejection(
      POST(
        event(
          db,
          namespaceId,
          jsonRequest({ partitionId, content: "Nope", layerId: foreignLayer }),
        ),
      ),
      400,
      "Layer not found in namespace",
    );
  });

  it("adds a new card to the requested scope", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const scopeId = await addScope({ db, name: "Current" });

    const response = await POST(
      event(db, namespaceId, jsonRequest({ partitionId, content: "Scoped card", scopeId })),
    );

    const { id } = await response.json();
    await expect(getScopeRelsByCards({ db, cardIds: [id] })).resolves.toEqual([
      { scopeId, cardId: id },
    ]);
  });

  it("rejects a missing scope without creating the card", async () => {
    const { db, namespaceId, partitionId } = await setup();

    await expectHttpRejection(
      POST(
        event(
          db,
          namespaceId,
          jsonRequest({ partitionId, content: "Scoped card", scopeId: "missing" }),
        ),
      ),
      400,
      "Scope not found",
    );
    await expect(getAllCards({ db, partitionId })).resolves.toHaveLength(0);
  });

  it("rejects blank card content", async () => {
    const { db, namespaceId, partitionId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ partitionId, content: "   " }))),
      400,
      "content is required",
    );
  });

  it("rejects partitions outside the namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Other",
    });

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ partitionId: otherPartitionId, content: "Nope" }))),
      400,
      "Partition not found in namespace",
    );
  });
});

describe("PATCH /[namespaceId]/api/cards", () => {
  it("updates card positions for cards in the namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Move me", posX: 0, posY: 0 });

    const response = await PATCH(
      event(db, namespaceId, jsonRequest({ positions: [{ cardId, posX: 72, posY: 96 }] })),
    );

    expect(response.status).toBe(200);
    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({
      posX: 72,
      posY: 96,
    });
  });

  it("rejects duplicate card ids before updating", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Still", posX: 0, posY: 0 });

    await expectHttpRejection(
      PATCH(
        event(
          db,
          namespaceId,
          jsonRequest({
            positions: [
              { cardId, posX: 24, posY: 24 },
              { cardId, posX: 48, posY: 48 },
            ],
          }),
        ),
      ),
      400,
      "cardId must be unique",
    );

    await expect(getCard({ db, partitionId, cardId })).resolves.toMatchObject({ posX: 0, posY: 0 });
  });

  it("rejects cards outside the namespace without updating local cards", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const localCardId = await addCard({ db, partitionId, content: "Local", posX: 0, posY: 0 });
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Other",
    });
    const otherCardId = await addCard({ db, partitionId: otherPartitionId, content: "Other" });

    await expectHttpRejection(
      PATCH(
        event(
          db,
          namespaceId,
          jsonRequest({
            positions: [
              { cardId: localCardId, posX: 24, posY: 24 },
              { cardId: otherCardId, posX: 48, posY: 48 },
            ],
          }),
        ),
      ),
      400,
      "Some cards do not belong to this namespace",
    );

    await expect(getCard({ db, partitionId, cardId: localCardId })).resolves.toMatchObject({
      posX: 0,
      posY: 0,
    });
  });
});

describe("DELETE /[namespaceId]/api/cards", () => {
  it("deletes cards belonging to the namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Gone" });

    const response = await DELETE(event(db, namespaceId, jsonRequest({ cardIds: [cardId] })));

    expect(response.status).toBe(200);
    await expect(getAllCards({ db, partitionId })).resolves.toHaveLength(0);
  });

  it("rejects cards outside the namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Not mine" });

    await expectHttpRejection(
      DELETE(event(db, namespaceId, jsonRequest({ cardIds: [foreignCard] }))),
      400,
      "Some cards do not belong to this namespace",
    );
  });

  it("rejects an empty cardIds array", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, namespaceId, jsonRequest({ cardIds: [] }))),
      400,
      "cardIds must have at least 1 item",
    );
  });
});
