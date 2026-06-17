import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addScope,
  getScope,
  getAllScopes,
  getScopesByProject,
  addProjectScopeRel,
  updateScopeName,
  deleteScope,
  deleteScopeFromProject,
} from "./scope.js";
import { addProject } from "./project.js";
import { addBundle } from "./bundle.js";
import { addCard } from "./card.js";
import { addScopeRel, getScopeRelsByCards } from "./scope-rel.js";
import { NotFoundError } from "./utils.js";

async function db() {
  return createTestDB();
}

describe("addScope", () => {
  it("returns a non-empty id", async () => {
    const d = await db();
    const id = await addScope({ db: d, name: "Release" });
    expect(id).toBeTruthy();
  });

  it("assigns unique ids", async () => {
    const d = await db();
    const id1 = await addScope({ db: d, name: "A" });
    const id2 = await addScope({ db: d, name: "B" });
    expect(id1).not.toBe(id2);
  });
});

describe("getScope", () => {
  it("returns the scope with matching id", async () => {
    const d = await db();
    const id = await addScope({ db: d, name: "Sprint 1" });
    const scope = await getScope({ db: d, scopeId: id });
    expect(scope).toEqual({ id, name: "Sprint 1" });
  });

  it("returns undefined for a missing id", async () => {
    const d = await db();
    expect(await getScope({ db: d, scopeId: "ghost" })).toBeUndefined();
  });
});

describe("getAllScopes", () => {
  it("returns empty array when no scopes exist", async () => {
    const d = await db();
    expect(await getAllScopes({ db: d })).toEqual([]);
  });

  it("returns all created scopes", async () => {
    const d = await db();
    const id1 = await addScope({ db: d, name: "Alpha" });
    const id2 = await addScope({ db: d, name: "Beta" });
    const scopes = await getAllScopes({ db: d });
    expect(scopes.map((s) => s.id)).toEqual(expect.arrayContaining([id1, id2]));
    expect(scopes).toHaveLength(2);
  });
});

describe("getScopesByProject", () => {
  it("returns only scopes associated with the project", async () => {
    const d = await db();
    const projectId = await addProject({ db: d, name: "P1" });
    const otherProjectId = await addProject({ db: d, name: "P2" });
    const scopeId = await addScope({ db: d, name: "Mine" });
    const otherScopeId = await addScope({ db: d, name: "Elsewhere" });
    await addProjectScopeRel({ db: d, projectId, scopeId });
    await addProjectScopeRel({ db: d, projectId: otherProjectId, scopeId: otherScopeId });

    const scopes = await getScopesByProject({ db: d, projectId });

    expect(scopes).toEqual([{ id: scopeId, name: "Mine" }]);
  });

  it("deduplicates multiple associations to the same scope", async () => {
    const d = await db();
    const projectId = await addProject({ db: d, name: "P" });
    const scopeId = await addScope({ db: d, name: "Shared" });
    // addProjectScopeRel is idempotent — a second insert should not duplicate
    await addProjectScopeRel({ db: d, projectId, scopeId });
    await addProjectScopeRel({ db: d, projectId, scopeId });

    expect(await getScopesByProject({ db: d, projectId })).toEqual([
      { id: scopeId, name: "Shared" },
    ]);
  });
});

describe("updateScopeName", () => {
  it("changes the scope name", async () => {
    const d = await db();
    const id = await addScope({ db: d, name: "Old" });
    await updateScopeName({ db: d, scopeId: id, name: "New" });
    const scope = await getScope({ db: d, scopeId: id });
    expect(scope?.name).toBe("New");
  });

  it("throws NotFoundError for a missing scope", async () => {
    const d = await db();
    await expect(updateScopeName({ db: d, scopeId: "ghost", name: "X" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("deleteScope", () => {
  it("removes the scope", async () => {
    const d = await db();
    const id = await addScope({ db: d, name: "ToDelete" });
    await deleteScope({ db: d, scopeId: id });
    expect(await getScope({ db: d, scopeId: id })).toBeUndefined();
  });

  it("throws NotFoundError for a missing scope", async () => {
    const d = await db();
    await expect(deleteScope({ db: d, scopeId: "ghost" })).rejects.toThrow(NotFoundError);
  });
});

describe("deleteScopeFromProject", () => {
  async function setup() {
    const d = await createTestDB();
    const projectId = await addProject({ db: d, name: "P" });
    const bundleId = await addBundle({ db: d, projectId, name: "B" });
    const scopeId = await addScope({ db: d, name: "S" });
    await addProjectScopeRel({ db: d, projectId, scopeId });
    return { d, projectId, bundleId, scopeId };
  }

  it("returns false when scope is not associated with the project", async () => {
    const { d, projectId } = await setup();
    const otherId = await addScope({ db: d, name: "Other" });
    expect(await deleteScopeFromProject({ db: d, projectId, scopeId: otherId })).toBe(false);
  });

  it("removes the project_scope_rel and deletes the scope when no other project references it", async () => {
    const { d, projectId, scopeId } = await setup();
    expect(await deleteScopeFromProject({ db: d, projectId, scopeId })).toBe(true);
    expect(await getScope({ db: d, scopeId })).toBeUndefined();
    expect(await getScopesByProject({ db: d, projectId })).toHaveLength(0);
  });

  it("removes scope_rel rows for cards belonging to this project", async () => {
    const { d, projectId, bundleId, scopeId } = await setup();
    const cardId = await addCard({ db: d, bundleId, content: "hi" });
    await addScopeRel({ db: d, scopeId, cardId });

    await deleteScopeFromProject({ db: d, projectId, scopeId });

    expect(await getScopeRelsByCards({ db: d, cardIds: [cardId] })).toHaveLength(0);
  });

  it("preserves scope and scope_rel for another project's cards when scope is shared", async () => {
    const d = await createTestDB();
    const p1 = await addProject({ db: d, name: "P1" });
    const p2 = await addProject({ db: d, name: "P2" });
    const b1 = await addBundle({ db: d, projectId: p1, name: "B1" });
    const b2 = await addBundle({ db: d, projectId: p2, name: "B2" });
    const scopeId = await addScope({ db: d, name: "Shared" });
    await addProjectScopeRel({ db: d, projectId: p1, scopeId });
    await addProjectScopeRel({ db: d, projectId: p2, scopeId });

    const card1 = await addCard({ db: d, bundleId: b1, content: "c1" });
    const card2 = await addCard({ db: d, bundleId: b2, content: "c2" });
    await addScopeRel({ db: d, scopeId, cardId: card1 });
    await addScopeRel({ db: d, scopeId, cardId: card2 });

    await deleteScopeFromProject({ db: d, projectId: p1, scopeId });

    // Scope still exists because p2 still references it
    expect(await getScope({ db: d, scopeId })).toBeDefined();
    // p1's card is removed from scope; p2's card is preserved
    expect(await getScopeRelsByCards({ db: d, cardIds: [card1] })).toHaveLength(0);
    expect(await getScopeRelsByCards({ db: d, cardIds: [card2] })).toHaveLength(1);
  });
});
