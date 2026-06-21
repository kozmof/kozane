import { describe, expect, it } from "vitest";
import { addBundle } from "../../../../../db/api/bundle.js";
import { addCard, getCardBundleNames } from "../../../../../db/api/card.js";
import { addProject } from "../../../../../db/api/project.js";
import type { DB } from "../../../../../db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/src-project/api/cards/move", {
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
  const srcId = await addProject({ db, name: "Source" });
  const dstId = await addProject({ db, name: "Destination" });
  const srcBundle = await addBundle({ db, projectId: srcId, name: "General", isDefault: true });
  return { db, srcId, dstId, srcBundle };
}

describe("POST /[projectId]/api/cards/move", () => {
  it("moves cards to the target project and returns ok", async () => {
    const { db, srcId, dstId, srcBundle } = await setup();
    const cardId = await addCard({ db, bundleId: srcBundle, content: "Move me" });

    const response = await POST(
      event(db, srcId, jsonRequest({ cardIds: [cardId], targetProjectId: dstId })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    const rows = await getCardBundleNames({ db, cardIds: [cardId] });
    expect(rows[0].bundleId).not.toBe(srcBundle);
  });

  it("rejects when targetProjectId equals the source project", async () => {
    const { db, srcId, srcBundle } = await setup();
    const cardId = await addCard({ db, bundleId: srcBundle, content: "Self-move" });

    await expectHttpRejection(
      POST(event(db, srcId, jsonRequest({ cardIds: [cardId], targetProjectId: srcId }))),
      400,
      "Target project must differ from source",
    );
  });

  it("rejects when cards do not belong to the source project", async () => {
    const { db, srcId, dstId } = await setup();
    const otherId = await addProject({ db, name: "Third" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Not mine" });

    await expectHttpRejection(
      POST(event(db, srcId, jsonRequest({ cardIds: [foreignCard], targetProjectId: dstId }))),
      400,
      "Some cards do not belong to this project",
    );
  });

  it("rejects a missing targetProjectId", async () => {
    const { db, srcId, srcBundle } = await setup();
    const cardId = await addCard({ db, bundleId: srcBundle, content: "Card" });

    await expectHttpRejection(
      POST(event(db, srcId, jsonRequest({ cardIds: [cardId] }))),
      400,
      "targetProjectId is required",
    );
  });

  it("rejects a missing cardIds array", async () => {
    const { db, srcId, dstId } = await setup();

    await expectHttpRejection(
      POST(event(db, srcId, jsonRequest({ targetProjectId: dstId }))),
      400,
      "cardIds must be an array",
    );
  });
});
