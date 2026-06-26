import { describe, expect, it } from "vitest";
import { addBundle } from "../../../../../db/api/bundle.js";
import { addCard } from "../../../../../db/api/card.js";
import { addScope, getAllScopes } from "../../../../../db/api/scope.js";
import { addScopeRel, getScopeRelsByCards } from "../../../../../db/api/scope-rel.js";
import { addProject } from "../../../../../db/api/project.js";
import type { DB } from "../../../../../db/tx.js";
import { createTestDB } from "../../../../../test-utils/db.js";
import { DELETE } from "./+server.js";

function event(db: DB, projectId: string, scopeId: string) {
  return {
    locals: { db },
    params: { projectId, scopeId },
    request: new Request("http://localhost/"),
  } as never;
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
  await addScopeRel({ db, scopeId, cardId });
  return { db, projectId, bundleId, scopeId, cardId };
}

describe("DELETE /[projectId]/api/scopes/[scopeId]", () => {
  it("removes the project's cards from the scope and deletes the scope when empty", async () => {
    const { db, projectId, scopeId, cardId } = await setup();

    const response = await DELETE(event(db, projectId, scopeId));

    expect(response.status).toBe(200);
    const scopes = await getAllScopes({ db });
    expect(scopes).toHaveLength(0);
    const rels = await getScopeRelsByCards({ db, cardIds: [cardId] });
    expect(rels).toHaveLength(0);
  });

  it("keeps the scope when another project still has cards in it", async () => {
    const { db, projectId, scopeId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const otherCard = await addCard({ db, bundleId: otherBundle, content: "Stays" });
    await addScopeRel({ db, scopeId, cardId: otherCard });

    await DELETE(event(db, projectId, scopeId));

    const scopes = await getAllScopes({ db });
    expect(scopes).toHaveLength(1);
  });

  it("returns 404 when the scope does not exist", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      DELETE(event(db, projectId, "nonexistent-scope-id")),
      404,
      "Scope not found in project",
    );
  });
});
