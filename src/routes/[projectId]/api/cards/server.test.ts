import { describe, expect, it } from "vitest";
import { addBundle } from "$db/api/bundle.js";
import { addCard, getCard, getAllCards } from "$db/api/card.js";
import { addProject } from "$db/api/project.js";
import { addScope } from "$db/api/scope.js";
import { getScopeRelsByCards } from "$db/api/scope-rel.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { DELETE, PATCH, POST } from "./+server.js";
import { addLayer, getDefaultLayer } from "$db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, request: Request) {
  return {
    locals: { db },
    params: { projectId },
    request,
  } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  await addLayer({ db, projectId: projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  return { db, projectId, bundleId };
}

describe("POST /[projectId]/api/cards", () => {
  it("creates a trimmed card in a project bundle", async () => {
    const { db, projectId, bundleId } = await setup();

    const response = await POST(
      event(db, projectId, jsonRequest({ bundleId, content: "  New card  ", posX: 24, posY: 48 })),
    );

    expect(response.status).toBe(200);
    const { id } = await response.json();
    await expect(getCard({ db, bundleId, cardId: id })).resolves.toMatchObject({
      content: "New card",
      posX: 24,
      posY: 48,
    });
  });

  it("puts a card on the project's default layer when none is requested", async () => {
    const { db, projectId, bundleId } = await setup();
    const defaultLayer = await getDefaultLayer({ db, projectId });

    const response = await POST(
      event(db, projectId, jsonRequest({ bundleId, content: "Unlayered" })),
    );

    expect(await response.json()).toMatchObject({ layerId: defaultLayer!.id });
  });

  it("puts a card on the requested layer", async () => {
    const { db, projectId, bundleId } = await setup();
    const { id: layerId } = await addLayer({ db, projectId, name: "Draft" });

    const response = await POST(
      event(db, projectId, jsonRequest({ bundleId, content: "Layered", layerId })),
    );

    const { id } = await response.json();
    await expect(getCard({ db, bundleId, cardId: id })).resolves.toMatchObject({ layerId });
  });

  it("rejects a layer from another project", async () => {
    const { db, projectId, bundleId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const { id: foreignLayer } = await addLayer({ db, projectId: otherId, name: "Theirs" });

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ bundleId, content: "Nope", layerId: foreignLayer }))),
      400,
      "Layer not found in project",
    );
  });

  it("adds a new card to the requested scope", async () => {
    const { db, projectId, bundleId } = await setup();
    const scopeId = await addScope({ db, name: "Current" });

    const response = await POST(
      event(db, projectId, jsonRequest({ bundleId, content: "Scoped card", scopeId })),
    );

    const { id } = await response.json();
    await expect(getScopeRelsByCards({ db, cardIds: [id] })).resolves.toEqual([
      { scopeId, cardId: id },
    ]);
  });

  it("rejects a missing scope without creating the card", async () => {
    const { db, projectId, bundleId } = await setup();

    await expectHttpRejection(
      POST(
        event(db, projectId, jsonRequest({ bundleId, content: "Scoped card", scopeId: "missing" })),
      ),
      400,
      "Scope not found",
    );
    await expect(getAllCards({ db, bundleId })).resolves.toHaveLength(0);
  });

  it("rejects blank card content", async () => {
    const { db, projectId, bundleId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ bundleId, content: "   " }))),
      400,
      "content is required",
    );
  });

  it("rejects bundles outside the project", async () => {
    const { db, projectId } = await setup();
    const otherProjectId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherProjectId, name: "Base", isDefault: true });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ bundleId: otherBundleId, content: "Nope" }))),
      400,
      "Bundle not found in project",
    );
  });
});

describe("PATCH /[projectId]/api/cards", () => {
  it("updates card positions for cards in the project", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Move me", posX: 0, posY: 0 });

    const response = await PATCH(
      event(db, projectId, jsonRequest({ positions: [{ cardId, posX: 72, posY: 96 }] })),
    );

    expect(response.status).toBe(200);
    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({
      posX: 72,
      posY: 96,
    });
  });

  it("rejects duplicate card ids before updating", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Still", posX: 0, posY: 0 });

    await expectHttpRejection(
      PATCH(
        event(
          db,
          projectId,
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

    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({ posX: 0, posY: 0 });
  });

  it("rejects cards outside the project without updating local cards", async () => {
    const { db, projectId, bundleId } = await setup();
    const localCardId = await addCard({ db, bundleId, content: "Local", posX: 0, posY: 0 });
    const otherProjectId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherProjectId, name: "Base", isDefault: true });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });
    const otherCardId = await addCard({ db, bundleId: otherBundleId, content: "Other" });

    await expectHttpRejection(
      PATCH(
        event(
          db,
          projectId,
          jsonRequest({
            positions: [
              { cardId: localCardId, posX: 24, posY: 24 },
              { cardId: otherCardId, posX: 48, posY: 48 },
            ],
          }),
        ),
      ),
      400,
      "Some cards do not belong to this project",
    );

    await expect(getCard({ db, bundleId, cardId: localCardId })).resolves.toMatchObject({
      posX: 0,
      posY: 0,
    });
  });
});

describe("DELETE /[projectId]/api/cards", () => {
  it("deletes cards belonging to the project", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "Gone" });

    const response = await DELETE(event(db, projectId, jsonRequest({ cardIds: [cardId] })));

    expect(response.status).toBe(200);
    await expect(getAllCards({ db, bundleId })).resolves.toHaveLength(0);
  });

  it("rejects cards outside the project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Not mine" });

    await expectHttpRejection(
      DELETE(event(db, projectId, jsonRequest({ cardIds: [foreignCard] }))),
      400,
      "Some cards do not belong to this project",
    );
  });

  it("rejects an empty cardIds array", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, projectId, jsonRequest({ cardIds: [] }))),
      400,
      "cardIds must have at least 1 item",
    );
  });
});
