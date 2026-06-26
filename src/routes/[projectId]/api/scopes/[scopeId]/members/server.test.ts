import { describe, expect, it } from "vitest";
import { addBundle } from "../../../../../../db/api/bundle.js";
import { addCard } from "../../../../../../db/api/card.js";
import { addScope } from "../../../../../../db/api/scope.js";
import { getScopeRelsByCards } from "../../../../../../db/api/scope-rel.js";
import { addProject } from "../../../../../../db/api/project.js";
import type { DB } from "../../../../../../db/tx.js";
import { createTestDB } from "../../../../../../test-utils/db.js";
import { DELETE, POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/scopes/scope-1/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, scopeId: string, request: Request) {
  return { locals: { db }, params: { projectId, scopeId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  const bundleId = await addBundle({ db, projectId, name: "General", isDefault: true });
  const scopeId = await addScope({ db, name: "My Scope" });
  const cardId = await addCard({ db, bundleId, content: "Card" });
  return { db, projectId, bundleId, scopeId, cardId };
}

describe("POST /[projectId]/api/scopes/[scopeId]/members", () => {
  it("adds cards from the project to the scope", async () => {
    const { db, projectId, scopeId, cardId } = await setup();

    const response = await POST(event(db, projectId, scopeId, jsonRequest({ cardIds: [cardId] })));

    expect(response.status).toBe(200);
    const rels = await getScopeRelsByCards({ db, cardIds: [cardId] });
    expect(rels).toHaveLength(1);
    expect(rels[0].scopeId).toBe(scopeId);
  });

  it("rejects cards that do not belong to the project", async () => {
    const { db, projectId, scopeId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      POST(event(db, projectId, scopeId, jsonRequest({ cardIds: [foreignCard] }))),
      400,
      "Some cards not found in project",
    );
  });

  it("rejects a missing cardIds", async () => {
    const { db, projectId, scopeId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, scopeId, jsonRequest({}))),
      400,
      "cardIds must be an array",
    );
  });
});

describe("DELETE /[projectId]/api/scopes/[scopeId]/members", () => {
  it("removes cards from the scope", async () => {
    const { db, projectId, scopeId, cardId } = await setup();
    await POST(event(db, projectId, scopeId, jsonRequest({ cardIds: [cardId] })));

    const response = await DELETE(
      event(db, projectId, scopeId, jsonRequest({ cardIds: [cardId] })),
    );

    expect(response.status).toBe(200);
    const rels = await getScopeRelsByCards({ db, cardIds: [cardId] });
    expect(rels).toHaveLength(0);
  });

  it("rejects cards that do not belong to the project", async () => {
    const { db, projectId, scopeId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Alien" });

    await expectHttpRejection(
      DELETE(event(db, projectId, scopeId, jsonRequest({ cardIds: [foreignCard] }))),
      400,
      "Some cards do not belong to this project",
    );
  });

  it("rejects a nonexistent scope", async () => {
    const { db, projectId, cardId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, projectId, "nonexistent-scope", jsonRequest({ cardIds: [cardId] }))),
      400,
      "Some cards do not belong to this project",
    );
  });
});
