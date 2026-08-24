import { describe, expect, it } from "vitest";
import { addBundle } from "$db/api/bundle.js";
import { addCard, getCard } from "$db/api/card.js";
import { addProject } from "$db/api/project.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { PATCH } from "./+server.js";
import { addLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/cards/layer", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, request: Request) {
  return { locals: { db }, params: { projectId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  await addLayer({ db, projectId, name: "Base", isDefault: true });
  const { id: targetLayerId } = await addLayer({ db, projectId, name: "Draft" });
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  const cardId = await addCard({ db, bundleId, content: "Card" });
  return { db, projectId, bundleId, targetLayerId, cardId };
}

describe("PATCH /[projectId]/api/cards/layer", () => {
  it("moves cards to a layer in the same project", async () => {
    const { db, projectId, bundleId, targetLayerId, cardId } = await setup();

    const response = await PATCH(
      event(db, projectId, jsonRequest({ layerId: targetLayerId, cardIds: [cardId] })),
    );

    expect(response.status).toBe(200);
    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({
      layerId: targetLayerId,
    });
  });

  it("rejects a layer that does not belong to the project", async () => {
    const { db, projectId, cardId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const { id: foreignLayer } = await addLayer({
      db,
      projectId: otherId,
      name: "Base",
      isDefault: true,
    });

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ layerId: foreignLayer, cardIds: [cardId] }))),
      400,
      "Layer not found in project",
    );
  });

  it("rejects cards that do not belong to the project", async () => {
    const { db, projectId, targetLayerId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ layerId: targetLayerId, cardIds: [foreignCard] }))),
      400,
      "Some cards do not belong to this project",
    );
  });

  it("rejects a missing layerId", async () => {
    const { db, projectId, cardId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ cardIds: [cardId] }))),
      400,
      "layerId is required",
    );
  });

  it("rejects a missing cardIds", async () => {
    const { db, projectId, targetLayerId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ layerId: targetLayerId }))),
      400,
      "cardIds must be an array",
    );
  });
});
