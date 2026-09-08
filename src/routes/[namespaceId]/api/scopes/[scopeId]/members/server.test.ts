import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard } from "$db/api/card.js";
import { addScope } from "$db/api/scope.js";
import { getScopeRelsByCards } from "$db/api/scope-rel.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../../test-utils/db.js";
import { DELETE, POST } from "./+server.js";
import { addLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/scopes/scope-1/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, namespaceId: string, scopeId: string, request: Request) {
  return { locals: { db }, params: { namespaceId, scopeId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  const scopeId = await addScope({ db, name: "My Scope" });
  const cardId = await addCard({ db, partitionId, content: "Card" });
  return { db, namespaceId, partitionId, scopeId, cardId };
}

describe("POST /[namespaceId]/api/scopes/[scopeId]/members", () => {
  it("adds cards from the namespace to the scope", async () => {
    const { db, namespaceId, scopeId, cardId } = await setup();

    const response = await POST(
      event(db, namespaceId, scopeId, jsonRequest({ cardIds: [cardId] })),
    );

    expect(response.status).toBe(200);
    const rels = await getScopeRelsByCards({ db, cardIds: [cardId] });
    expect(rels).toHaveLength(1);
    expect(rels[0].scopeId).toBe(scopeId);
  });

  it("rejects cards that do not belong to the namespace", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Alien" });

    await expectHttpRejection(
      POST(event(db, namespaceId, scopeId, jsonRequest({ cardIds: [foreignCard] }))),
      400,
      "Some cards do not belong to this namespace",
    );
  });

  it("rejects a nonexistent scope", async () => {
    const { db, namespaceId, cardId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, "nonexistent-scope", jsonRequest({ cardIds: [cardId] }))),
      400,
      "Scope not found",
    );
  });

  it("rejects a missing cardIds", async () => {
    const { db, namespaceId, scopeId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, scopeId, jsonRequest({}))),
      400,
      "cardIds must be an array",
    );
  });
});

describe("DELETE /[namespaceId]/api/scopes/[scopeId]/members", () => {
  it("removes cards from the scope", async () => {
    const { db, namespaceId, scopeId, cardId } = await setup();
    await POST(event(db, namespaceId, scopeId, jsonRequest({ cardIds: [cardId] })));

    const response = await DELETE(
      event(db, namespaceId, scopeId, jsonRequest({ cardIds: [cardId] })),
    );

    expect(response.status).toBe(200);
    const rels = await getScopeRelsByCards({ db, cardIds: [cardId] });
    expect(rels).toHaveLength(0);
  });

  it("rejects cards that do not belong to the namespace", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Alien" });

    await expectHttpRejection(
      DELETE(event(db, namespaceId, scopeId, jsonRequest({ cardIds: [foreignCard] }))),
      400,
      "Some cards do not belong to this namespace",
    );
  });

  it("rejects a nonexistent scope", async () => {
    const { db, namespaceId, cardId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, namespaceId, "nonexistent-scope", jsonRequest({ cardIds: [cardId] }))),
      400,
      "Scope not found",
    );
  });
});
