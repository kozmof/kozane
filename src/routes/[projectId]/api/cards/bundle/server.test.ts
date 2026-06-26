import { describe, expect, it } from "vitest";
import { addBundle } from "../../../../../db/api/bundle.js";
import { addCard, getCard } from "../../../../../db/api/card.js";
import { addProject } from "../../../../../db/api/project.js";
import type { DB } from "../../../../../db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { PATCH } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/cards/bundle", {
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
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  const targetBundleId = await addBundle({ db, projectId, name: "Target" });
  const cardId = await addCard({ db, bundleId, content: "Card" });
  return { db, projectId, bundleId, targetBundleId, cardId };
}

describe("PATCH /[projectId]/api/cards/bundle", () => {
  it("reassigns cards to a bundle in the same project", async () => {
    const { db, projectId, targetBundleId, cardId } = await setup();

    const response = await PATCH(
      event(db, projectId, jsonRequest({ bundleId: targetBundleId, cardIds: [cardId] })),
    );

    expect(response.status).toBe(200);
    const card = await getCard({ db, bundleId: targetBundleId, cardId });
    expect(card).toBeDefined();
  });

  it("rejects a bundle that does not belong to the project", async () => {
    const { db, projectId, cardId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ bundleId: otherBundle, cardIds: [cardId] }))),
      400,
      "Bundle not found in project",
    );
  });

  it("rejects cards that do not belong to the project", async () => {
    const { db, projectId, targetBundleId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      PATCH(
        event(db, projectId, jsonRequest({ bundleId: targetBundleId, cardIds: [foreignCard] })),
      ),
      400,
      "Some cards do not belong to this project",
    );
  });

  it("rejects a missing bundleId", async () => {
    const { db, projectId, cardId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ cardIds: [cardId] }))),
      400,
      "bundleId is required",
    );
  });

  it("rejects a missing cardIds", async () => {
    const { db, projectId, targetBundleId } = await setup();

    await expectHttpRejection(
      PATCH(event(db, projectId, jsonRequest({ bundleId: targetBundleId }))),
      400,
      "cardIds must be an array",
    );
  });
});
