import { describe, expect, it } from "vitest";
import { addLayer, getAllLayers } from "$db/api/layer.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { PATCH, POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/layers", {
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
  return { db, namespaceId };
}

describe("POST /[namespaceId]/api/layers", () => {
  it("creates a layer on top of the existing ones", async () => {
    const { db, namespaceId } = await setup();

    const response = await POST(event(db, namespaceId, jsonRequest({ name: "  Draft  " })));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "Draft", position: 1, isDefault: false });

    const layers = await getAllLayers({ db, namespaceId });
    expect(layers.map(({ name }) => name)).toEqual(["Base", "Draft"]);
  });

  it("rejects a blank name", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ name: "   " }))),
      400,
      "name is required",
    );
  });

  it("rejects a duplicate layer name within the same namespace", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      POST(event(db, namespaceId, jsonRequest({ name: "Base" }))),
      400,
      'A layer named "Base" already exists',
    );
  });

  it("returns 404 for a nonexistent namespace", async () => {
    const { db } = await setup();

    await expectHttpRejection(
      POST(event(db, "nonexistent-namespace-id", jsonRequest({ name: "Draft" }))),
      404,
      "Namespace not found",
    );
  });
});

describe("PATCH /[namespaceId]/api/layers", () => {
  async function setupThree() {
    const { db, namespaceId } = await setup();
    const { id: draft } = await addLayer({ db, namespaceId, name: "Draft" });
    const { id: notes } = await addLayer({ db, namespaceId, name: "Notes" });
    const [base] = await getAllLayers({ db, namespaceId });
    return { db, namespaceId, base: base.id, draft, notes };
  }

  it("renumbers the layers from a full bottom-to-top ordering", async () => {
    const { db, namespaceId, base, draft, notes } = await setupThree();

    const response = await PATCH(
      event(db, namespaceId, jsonRequest({ layerIds: [notes, base, draft] })),
    );

    expect(response.status).toBe(200);
    expect((await getAllLayers({ db, namespaceId })).map(({ name }) => name)).toEqual([
      "Notes",
      "Base",
      "Draft",
    ]);
  });

  it("rejects a partial ordering without renumbering", async () => {
    const { db, namespaceId, base, draft } = await setupThree();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ layerIds: [draft, base] }))),
      400,
      "The namespace's layers changed elsewhere. Reload to see the current order.",
    );
    expect((await getAllLayers({ db, namespaceId })).map(({ name }) => name)).toEqual([
      "Base",
      "Draft",
      "Notes",
    ]);
  });

  it("rejects an ordering naming a layer from another namespace", async () => {
    const { db, namespaceId, base, draft } = await setupThree();
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    const { id: foreign } = await addLayer({ db, namespaceId: otherNamespaceId, name: "Theirs" });

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ layerIds: [base, draft, foreign] }))),
      400,
      "layerIds must only name layers of this namespace",
    );
  });

  it("rejects an empty ordering", async () => {
    const { db, namespaceId } = await setupThree();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, jsonRequest({ layerIds: [] }))),
      400,
      "layerIds must have at least 1 item",
    );
  });
});
