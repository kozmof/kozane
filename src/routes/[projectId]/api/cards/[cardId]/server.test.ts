import { describe, expect, it } from "vitest";
import { addBundle } from "../../../../../db/api/bundle.js";
import { addCard, getCard } from "../../../../../db/api/card.js";
import { addProject } from "../../../../../db/api/project.js";
import type { DB } from "../../../../../db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE, PATCH } from "./+server.js";
import { addLayer } from "../../../../../db/api/layer.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/cards/card-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, cardId: string, request: Request) {
  return { locals: { db }, params: { projectId, cardId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  await addLayer({ db, projectId: projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  const cardId = await addCard({ db, bundleId, content: "Original" });
  return { db, projectId, bundleId, cardId };
}

describe("PATCH /[projectId]/api/cards/[cardId]", () => {
  it("updates card content", async () => {
    const { db, projectId, bundleId, cardId } = await setup();

    const response = await PATCH(
      event(db, projectId, cardId, jsonRequest({ content: "  Updated  " })),
    );

    expect(response.status).toBe(200);
    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({
      content: "Updated",
    });
  });

  it("updates card position", async () => {
    const { db, projectId, bundleId, cardId } = await setup();

    await PATCH(event(db, projectId, cardId, jsonRequest({ posX: 48, posY: 72 })));

    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({ posX: 48, posY: 72 });
  });

  it("updates card stacking order", async () => {
    const { db, projectId, bundleId, cardId } = await setup();
    await PATCH(event(db, projectId, cardId, jsonRequest({ zIndex: 42 })));
    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({ zIndex: 42 });
  });

  it("rejects a non-integer card stacking order", async () => {
    const { db, projectId, cardId } = await setup();
    await expectHttpRejection(
      PATCH(event(db, projectId, cardId, jsonRequest({ zIndex: 1.5 }))),
      400,
      "zIndex must be an integer",
    );
  });

  it("updates card width", async () => {
    const { db, projectId, bundleId, cardId } = await setup();
    await PATCH(event(db, projectId, cardId, jsonRequest({ width: 360 })));
    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({ width: 360 });
  });

  it("clears card width when it is sent as null", async () => {
    const { db, projectId, bundleId, cardId } = await setup();
    await PATCH(event(db, projectId, cardId, jsonRequest({ width: 360 })));

    await PATCH(event(db, projectId, cardId, jsonRequest({ width: null })));

    // Null is a value here, not an omission: the card goes back to following
    // `ui.defaultCardWidth` rather than keeping the 360 it was just given.
    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({ width: null });
  });

  it("rejects a non-integer card width", async () => {
    const { db, projectId, cardId } = await setup();
    await expectHttpRejection(
      PATCH(event(db, projectId, cardId, jsonRequest({ width: 210.5 }))),
      400,
      "width must be an integer",
    );
  });

  it("rejects a card width outside the allowed range", async () => {
    const { db, projectId, cardId } = await setup();
    await expectHttpRejection(
      PATCH(event(db, projectId, cardId, jsonRequest({ width: 39 }))),
      400,
      "width must be between 40 and 1200",
    );
    await expectHttpRejection(
      PATCH(event(db, projectId, cardId, jsonRequest({ width: 1201 }))),
      400,
      "width must be between 40 and 1200",
    );
  });

  it("moves card to another bundle in the same project", async () => {
    const { db, projectId, cardId } = await setup();
    const otherBundleId = await addBundle({ db, projectId, name: "Other" });

    await PATCH(event(db, projectId, cardId, jsonRequest({ bundleId: otherBundleId })));

    const card = await getCard({ db, bundleId: otherBundleId, cardId });
    expect(card).toBeDefined();
  });

  it("rejects blank content", async () => {
    const { db, projectId, cardId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, cardId, jsonRequest({ content: "   " }))),
      400,
      "content must not be empty",
    );
  });

  it("rejects a bundle from another project", async () => {
    const { db, projectId, cardId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });

    await expectHttpRejection(
      PATCH(event(db, projectId, cardId, jsonRequest({ bundleId: otherBundle }))),
      400,
      "New bundle not found in project",
    );
  });

  it("rejects a card that does not belong to the project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      PATCH(event(db, projectId, foreignCard, jsonRequest({ content: "Nope" }))),
      404,
      "Card not found",
    );
  });

  it("moves the card to another layer of the project", async () => {
    const { db, projectId, bundleId, cardId } = await setup();
    const { id: layerId } = await addLayer({ db, projectId, name: "Draft" });

    const response = await PATCH(event(db, projectId, cardId, jsonRequest({ layerId })));

    expect(response.status).toBe(200);
    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({ layerId });
  });

  it("rejects a layer from another project", async () => {
    const { db, projectId, bundleId, cardId } = await setup();
    const before = await getCard({ db, bundleId, cardId });
    const otherProjectId = await addProject({ db, name: "Other" });
    const { id: foreignLayer } = await addLayer({
      db,
      projectId: otherProjectId,
      name: "Theirs",
      isDefault: true,
    });

    await expectHttpRejection(
      PATCH(event(db, projectId, cardId, jsonRequest({ layerId: foreignLayer }))),
      400,
      "New layer not found in project",
    );
    await expect(getCard({ db, bundleId, cardId })).resolves.toMatchObject({
      layerId: before!.layerId,
    });
  });

  it("rejects a request with no updatable fields", async () => {
    const { db, projectId, cardId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, cardId, jsonRequest({}))),
      400,
      "No fields to update",
    );
  });
});

describe("DELETE /[projectId]/api/cards/[cardId]", () => {
  it("deletes a card in the project", async () => {
    const { db, projectId, bundleId, cardId } = await setup();

    const response = await DELETE(event(db, projectId, cardId, new Request("http://localhost/")));

    expect(response.status).toBe(200);
    await expect(getCard({ db, bundleId, cardId })).resolves.toBeUndefined();
  });

  it("rejects a card that does not belong to the project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      DELETE(event(db, projectId, foreignCard, new Request("http://localhost/"))),
      404,
      "Card not found",
    );
  });
});
