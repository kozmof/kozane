import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard } from "$db/api/card.js";
import { getGlueRelsByCards } from "$db/api/glue.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { DELETE, POST } from "./+server.js";
import { addLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/glues", {
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
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  const cardId1 = await addCard({ db, partitionId, content: "A" });
  const cardId2 = await addCard({ db, partitionId, content: "B" });
  const cardId3 = await addCard({ db, partitionId, content: "C" });
  return { db, namespaceId, partitionId, cardId1, cardId2, cardId3 };
}

describe("POST /[namespaceId]/api/glues", () => {
  it("glues cards in the namespace and returns a glueId", async () => {
    const { db, namespaceId, cardId1, cardId2 } = await setup();

    const response = await POST(
      event(db, namespaceId, jsonRequest({ cardIds: [cardId1, cardId2] })),
    );

    expect(response.status).toBe(200);
    const { glueId } = await response.json();
    expect(typeof glueId).toBe("string");

    const rels = await getGlueRelsByCards({ db, cardIds: [cardId1, cardId2] });
    expect(rels).toHaveLength(2);
    expect(rels.every((r) => r.glueId === glueId)).toBe(true);
  });

  it("rejects fewer than 2 cardIds", async () => {
    const { db, namespaceId, cardId1 } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ cardIds: [cardId1] }))),
      400,
      "cardIds must have at least 2 items",
    );
  });

  it("rejects cards outside the namespace", async () => {
    const { db, namespaceId, cardId1 } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Alien" });

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ cardIds: [cardId1, foreignCard] }))),
      400,
      "Some cards do not belong to this namespace",
    );
  });

  it("rejects duplicate cardIds", async () => {
    const { db, namespaceId, cardId1 } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ cardIds: [cardId1, cardId1] }))),
      400,
      "cardIds must be unique",
    );
  });
});

describe("DELETE /[namespaceId]/api/glues", () => {
  it("unglues cards and returns cleared card ids", async () => {
    const { db, namespaceId, cardId1, cardId2 } = await setup();
    await POST(event(db, namespaceId, jsonRequest({ cardIds: [cardId1, cardId2] })));

    const response = await DELETE(
      event(db, namespaceId, jsonRequest({ cardIds: [cardId1, cardId2] })),
    );

    expect(response.status).toBe(200);
    const { clearedCardIds } = await response.json();
    expect(new Set(clearedCardIds)).toEqual(new Set([cardId1, cardId2]));
    const rels = await getGlueRelsByCards({ db, cardIds: [cardId1, cardId2] });
    expect(rels).toHaveLength(0);
  });

  it("rejects cards outside the namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Alien" });

    await expectHttpRejection(
      DELETE(event(db, namespaceId, jsonRequest({ cardIds: [foreignCard] }))),
      400,
      "Some cards do not belong to this namespace",
    );
  });
});
