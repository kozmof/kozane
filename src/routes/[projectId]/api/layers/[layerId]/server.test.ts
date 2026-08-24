import { describe, expect, it } from "vitest";
import { addBundle } from "$db/api/bundle.js";
import { addCard, getCard } from "$db/api/card.js";
import { addLayer, getAllLayers } from "$db/api/layer.js";
import { addProject } from "$db/api/project.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE, PATCH } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/layers/layer-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, layerId: string, request?: Request) {
  return { locals: { db }, params: { projectId, layerId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  const { id: defaultLayerId } = await addLayer({
    db,
    projectId,
    name: "Base",
    isDefault: true,
  });
  const { id: layerId } = await addLayer({ db, projectId, name: "Draft" });
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  return { db, projectId, defaultLayerId, layerId, bundleId };
}

describe("PATCH /[projectId]/api/layers/[layerId]", () => {
  it("renames a layer", async () => {
    const { db, projectId, layerId } = await setup();

    const response = await PATCH(event(db, projectId, layerId, jsonRequest({ name: "  Final  " })));

    expect(response.status).toBe(200);
    const layers = await getAllLayers({ db, projectId });
    expect(layers.find((l) => l.id === layerId)?.name).toBe("Final");
  });

  it("rejects a duplicate name", async () => {
    const { db, projectId, layerId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, layerId, jsonRequest({ name: "Base" }))),
      400,
      'A layer named "Base" already exists',
    );
  });

  it("returns 404 for an unknown layer", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, "ghost", jsonRequest({ name: "Final" }))),
      404,
      "Layer projectId=" + projectId + " layerId=ghost not found",
    );
  });
});

describe("DELETE /[projectId]/api/layers/[layerId]", () => {
  it("deletes the layer and moves its cards to the default layer", async () => {
    const { db, projectId, defaultLayerId, layerId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, layerId, content: "Keep me" });

    const response = await DELETE(event(db, projectId, layerId));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, defaultLayerId });
    expect(await getCard({ db, bundleId, cardId })).toMatchObject({ layerId: defaultLayerId });
    expect((await getAllLayers({ db, projectId })).map(({ id }) => id)).toEqual([defaultLayerId]);
  });

  it("refuses to delete the default layer", async () => {
    const { db, projectId, defaultLayerId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, projectId, defaultLayerId)),
      400,
      "Cannot delete the default layer",
    );
  });

  it("returns 404 for a layer in another project", async () => {
    const { db, layerId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });

    await expectHttpRejection(
      DELETE(event(db, otherId, layerId)),
      404,
      "Layer projectId=" + otherId + " layerId=" + layerId + " not found",
    );
  });
});
