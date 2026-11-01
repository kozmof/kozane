import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard } from "$db/api/card.js";
import { addScope, getAllScopes } from "$db/api/scope.js";
import { addScopeRel, getScopeRelsByCards } from "$db/api/scope-rel.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE, PATCH } from "./+server.js";
import { addLayer } from "$db/api/layer.js";

function event(db: DB, namespaceId: string, scopeId: string) {
  return {
    locals: { db },
    params: { namespaceId, scopeId },
    request: new Request("http://localhost/"),
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
  const scopeId = await addScope({ db, name: "My Scope" });
  const cardId = await addCard({ db, partitionId, content: "Card" });
  await addScopeRel({ db, scopeId, cardId });
  return { db, namespaceId, partitionId, scopeId, cardId };
}

describe("DELETE /[namespaceId]/api/scopes/[scopeId]", () => {
  it("removes the namespace's cards from the scope and deletes the scope when empty", async () => {
    const { db, namespaceId, scopeId, cardId } = await setup();

    const response = await DELETE(event(db, namespaceId, scopeId));

    expect(response.status).toBe(200);
    const scopes = await getAllScopes({ db });
    expect(scopes).toHaveLength(0);
    const rels = await getScopeRelsByCards({ db, cardIds: [cardId] });
    expect(rels).toHaveLength(0);
  });

  it("keeps the scope when another namespace still has cards in it", async () => {
    const { db, namespaceId, scopeId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const otherCard = await addCard({ db, partitionId: otherPartition, content: "Stays" });
    await addScopeRel({ db, scopeId, cardId: otherCard });

    await DELETE(event(db, namespaceId, scopeId));

    const scopes = await getAllScopes({ db });
    expect(scopes).toHaveLength(1);
  });

  it("returns 404 when the scope does not exist", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, namespaceId, "nonexistent-scope-id")),
      404,
      "Scope not found in namespace",
    );
  });
});

function patchEvent(db: DB, namespaceId: string, scopeId: string, payload: unknown) {
  return {
    locals: { db },
    params: { namespaceId, scopeId },
    request: new Request("http://localhost/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  } as never;
}

describe("PATCH /[namespaceId]/api/scopes/[scopeId]", () => {
  it("renames the scope", async () => {
    const { db, namespaceId, scopeId } = await setup();

    const res = await PATCH(patchEvent(db, namespaceId, scopeId, { name: "Renamed" }));

    expect(await res.json()).toEqual({ id: scopeId, name: "Renamed" });
    expect((await getAllScopes({ db })).map(({ name }) => name)).toEqual(["Renamed"]);
  });

  it("refuses a name another scope uses", async () => {
    const { db, namespaceId, scopeId } = await setup();
    await addScope({ db, name: "Taken" });

    await expectHttpRejection(
      PATCH(patchEvent(db, namespaceId, scopeId, { name: "Taken" })),
      400,
      'A scope named "Taken" already exists',
    );
  });

  it("404s an unknown scope and 400s a blank name", async () => {
    const { db, namespaceId, scopeId } = await setup();

    await expectHttpRejection(
      PATCH(patchEvent(db, namespaceId, "missing", { name: "X" })),
      404,
      "Scope not found",
    );
    await expect(
      Promise.resolve(PATCH(patchEvent(db, namespaceId, scopeId, { name: "  " }))),
    ).rejects.toMatchObject({ status: 400 });
  });
});
