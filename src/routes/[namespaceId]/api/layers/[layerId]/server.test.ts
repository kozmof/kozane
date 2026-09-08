import { describe, expect, it } from "vitest";
import { addPartition } from "$db/api/partition.js";
import { addCard, getCard } from "$db/api/card.js";
import { addLayer, getAllLayers } from "$db/api/layer.js";
import { addNamespace } from "$db/api/namespace.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE, PATCH } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/namespace-1/api/layers/layer-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, namespaceId: string, layerId: string, request?: Request) {
  return { locals: { db }, params: { namespaceId, layerId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  const { id: defaultLayerId } = await addLayer({
    db,
    namespaceId,
    name: "Base",
    isDefault: true,
  });
  const { id: layerId } = await addLayer({ db, namespaceId, name: "Draft" });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  return { db, namespaceId, defaultLayerId, layerId, partitionId };
}

describe("PATCH /[namespaceId]/api/layers/[layerId]", () => {
  it("renames a layer", async () => {
    const { db, namespaceId, layerId } = await setup();

    const response = await PATCH(
      event(db, namespaceId, layerId, jsonRequest({ name: "  Final  " })),
    );

    expect(response.status).toBe(200);
    const layers = await getAllLayers({ db, namespaceId });
    expect(layers.find((l) => l.id === layerId)?.name).toBe("Final");
  });

  it("rejects a duplicate name", async () => {
    const { db, namespaceId, layerId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, layerId, jsonRequest({ name: "Base" }))),
      400,
      'A layer named "Base" already exists',
    );
  });

  it("returns 404 for an unknown layer", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, namespaceId, "ghost", jsonRequest({ name: "Final" }))),
      404,
      "Layer namespaceId=" + namespaceId + " layerId=ghost not found",
    );
  });
});

describe("DELETE /[namespaceId]/api/layers/[layerId]", () => {
  it("deletes the layer and moves its cards to the default layer", async () => {
    const { db, namespaceId, defaultLayerId, layerId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, layerId, content: "Keep me" });

    const response = await DELETE(event(db, namespaceId, layerId));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, defaultLayerId });
    expect(await getCard({ db, partitionId, cardId })).toMatchObject({ layerId: defaultLayerId });
    expect((await getAllLayers({ db, namespaceId })).map(({ id }) => id)).toEqual([defaultLayerId]);
  });

  it("refuses to delete the default layer", async () => {
    const { db, namespaceId, defaultLayerId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, namespaceId, defaultLayerId)),
      400,
      "Cannot delete the default layer",
    );
  });

  it("returns 404 for a layer in another namespace", async () => {
    const { db, layerId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });

    await expectHttpRejection(
      DELETE(event(db, otherId, layerId)),
      404,
      "Layer namespaceId=" + otherId + " layerId=" + layerId + " not found",
    );
  });
});
