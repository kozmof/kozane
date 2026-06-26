import { describe, expect, it } from "vitest";
import { addBundle } from "../../../../../db/api/bundle.js";
import { addCard, getCard } from "../../../../../db/api/card.js";
import { addProject } from "../../../../../db/api/project.js";
import type { DB } from "../../../../../db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE, PATCH } from "./+server.js";

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
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      PATCH(event(db, projectId, foreignCard, jsonRequest({ content: "Nope" }))),
      404,
      "Card not found",
    );
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
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      DELETE(event(db, projectId, foreignCard, new Request("http://localhost/"))),
      404,
      "Card not found",
    );
  });
});
