import { describe, expect, it } from "vitest";
import { addBundle } from "$db/api/bundle.js";
import { addCard, getCard } from "$db/api/card.js";
import { addLayer } from "$db/api/layer.js";
import { addProject } from "$db/api/project.js";
import { BATCH_MAX } from "../../../../../lib/constants.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/cards/squash", {
    method: "POST",
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
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  const cardId = await addCard({
    db,
    bundleId,
    content: "First thought. Second thought",
    posX: 240,
    posY: 120,
  });
  return { db, projectId, bundleId, cardId };
}

describe("POST /[projectId]/api/cards/squash", () => {
  it("answers with the stored pieces and removes the card", async () => {
    const { db, projectId, bundleId, cardId } = await setup();

    const response = await POST(event(db, projectId, jsonRequest({ cardId })));

    expect(response.status).toBe(200);
    const { cards } = await response.json();
    expect(cards).toEqual([
      expect.objectContaining({ content: "First thought", posX: 240, posY: 120, glueId: null }),
      expect.objectContaining({ content: "Second thought", posX: 520, posY: 120, glueId: null }),
    ]);
    await expect(getCard({ db, bundleId, cardId })).resolves.toBeUndefined();
  });

  it("rejects a card that does not belong to the project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreign = await addCard({ db, bundleId: otherBundle, content: "One. Two" });

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ cardId: foreign }))),
      400,
      "Card not found in project",
    );
  });

  it("rejects a card whose text does not split", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "One indivisible thought" });

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ cardId }))),
      400,
      "Card text does not split into more than one card",
    );
  });

  it("rejects a card that splits into more cards than one request may carry", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({
      db,
      bundleId,
      content: Array.from({ length: BATCH_MAX + 1 }, (_, i) => `Piece ${i}`).join(". "),
    });

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ cardId }))),
      400,
      `Card text splits into more than ${BATCH_MAX} cards`,
    );
  });

  it("rejects a missing cardId", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({}))),
      400,
      "cardId is required",
    );
  });
});
