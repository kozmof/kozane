import { describe, expect, it } from "vitest";
import { addBundle } from "../../../../db/api/bundle.js";
import { addCard } from "../../../../db/api/card.js";
import { getGlueRelsByCards } from "../../../../db/api/glue.js";
import { addProject } from "../../../../db/api/project.js";
import type { DB } from "../../../../db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { DELETE, POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/glues", {
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
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  const cardId1 = await addCard({ db, bundleId, content: "A" });
  const cardId2 = await addCard({ db, bundleId, content: "B" });
  const cardId3 = await addCard({ db, bundleId, content: "C" });
  return { db, projectId, bundleId, cardId1, cardId2, cardId3 };
}

describe("POST /[projectId]/api/glues", () => {
  it("glues cards in the project and returns a glueId", async () => {
    const { db, projectId, cardId1, cardId2 } = await setup();

    const response = await POST(
      event(db, projectId, jsonRequest({ cardIds: [cardId1, cardId2] })),
    );

    expect(response.status).toBe(200);
    const { glueId } = await response.json();
    expect(typeof glueId).toBe("string");

    const rels = await getGlueRelsByCards({ db, cardIds: [cardId1, cardId2] });
    expect(rels).toHaveLength(2);
    expect(rels.every((r) => r.glueId === glueId)).toBe(true);
  });

  it("rejects fewer than 2 cardIds", async () => {
    const { db, projectId, cardId1 } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ cardIds: [cardId1] }))),
      400,
      "cardIds must have at least 2 items",
    );
  });

  it("rejects cards outside the project", async () => {
    const { db, projectId, cardId1 } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ cardIds: [cardId1, foreignCard] }))),
      400,
      "Some cards do not belong to this project",
    );
  });

  it("rejects duplicate cardIds", async () => {
    const { db, projectId, cardId1 } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ cardIds: [cardId1, cardId1] }))),
      400,
      "cardIds must be unique",
    );
  });
});

describe("DELETE /[projectId]/api/glues", () => {
  it("unglues cards and returns cleared card ids", async () => {
    const { db, projectId, cardId1, cardId2 } = await setup();
    await POST(event(db, projectId, jsonRequest({ cardIds: [cardId1, cardId2] })));

    const response = await DELETE(
      event(db, projectId, jsonRequest({ cardIds: [cardId1, cardId2] })),
    );

    expect(response.status).toBe(200);
    const { clearedCardIds } = await response.json();
    expect(new Set(clearedCardIds)).toEqual(new Set([cardId1, cardId2]));
    const rels = await getGlueRelsByCards({ db, cardIds: [cardId1, cardId2] });
    expect(rels).toHaveLength(0);
  });

  it("rejects cards outside the project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      DELETE(event(db, projectId, jsonRequest({ cardIds: [foreignCard] }))),
      400,
      "Some cards do not belong to this project",
    );
  });
});
