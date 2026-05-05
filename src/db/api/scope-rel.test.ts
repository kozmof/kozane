import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  addScopeRel,
  removeScopeRel,
  getAllCardsByScope,
  getCardsByScopeWithBundleName,
  addScopeMembers,
  removeScopeMembers,
  removeScopeMembersFromProject,
  getScopeRelsByCards,
} from "./scope-rel.js";
import { addProject } from "./project.js";
import { addBundle } from "./bundle.js";
import { addCard } from "./card.js";
import { addScope } from "./scope.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  const scopeId = await addScope({ db, name: "S" });
  const cardId = await addCard({ db, bundleId, content: "Card A" });
  return { db, projectId, bundleId, scopeId, cardId };
}

describe("addScopeRel", () => {
  it("adds a card to a scope", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards.map((c) => c.id)).toContain(cardId);
  });

  it("is idempotent — duplicate insert does not throw", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    await expect(addScopeRel({ db, scopeId, cardId })).resolves.toBeUndefined();
  });
});

describe("removeScopeRel", () => {
  it("removes the card from the scope", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    await removeScopeRel({ db, scopeId, cardId });
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards.map((c) => c.id)).not.toContain(cardId);
  });

  it("throws NotFoundError when the relationship does not exist", async () => {
    const { db, scopeId, cardId } = await setup();
    await expect(removeScopeRel({ db, scopeId, cardId })).rejects.toThrow(NotFoundError);
  });
});

describe("getAllCardsByScope", () => {
  it("returns empty array when scope has no members", async () => {
    const { db, scopeId } = await setup();
    expect(await getAllCardsByScope({ db, scopeId })).toEqual([]);
  });

  it("returns cards that are members of the scope", async () => {
    const { db, bundleId, scopeId, cardId } = await setup();
    const c2 = await addCard({ db, bundleId, content: "Card B" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: c2 });
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining([cardId, c2]));
    expect(cards).toHaveLength(2);
  });
});

describe("getCardsByScopeWithBundleName", () => {
  it("returns cards with bundleName and glueId fields", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    const cards = await getCardsByScopeWithBundleName({ db, scopeId });
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(cardId);
    expect(cards[0].bundleName).toBe("B");
    expect(cards[0].glueId).toBeNull();
  });

  it("returns empty array when scope has no members", async () => {
    const { db, scopeId } = await setup();
    expect(await getCardsByScopeWithBundleName({ db, scopeId })).toEqual([]);
  });
});

describe("addScopeMembers", () => {
  it("adds multiple cards at once and returns true", async () => {
    const { db, bundleId, projectId, scopeId, cardId } = await setup();
    const c2 = await addCard({ db, bundleId, content: "Card B" });
    const ok = await addScopeMembers({ db, scopeId, projectId, cardIds: [cardId, c2] });
    expect(ok).toBe(true);
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining([cardId, c2]));
  });

  it("returns false when a cardId does not belong to the project", async () => {
    const db = await createTestDB();
    const p1 = await addProject({ db, name: "P1" });
    const p2 = await addProject({ db, name: "P2" });
    const b1 = await addBundle({ db, projectId: p1, name: "B1" });
    const b2 = await addBundle({ db, projectId: p2, name: "B2" });
    const scopeId = await addScope({ db, name: "S" });
    const cardInP1 = await addCard({ db, bundleId: b1, content: "C1" });
    const cardInP2 = await addCard({ db, bundleId: b2, content: "C2" });
    // Trying to add a card from p2 while claiming project p1
    const ok = await addScopeMembers({ db, scopeId, projectId: p1, cardIds: [cardInP1, cardInP2] });
    expect(ok).toBe(false);
  });

  it("is idempotent — adding the same cards again returns true and does not duplicate", async () => {
    const { db, projectId, scopeId, cardId } = await setup();
    await addScopeMembers({ db, scopeId, projectId, cardIds: [cardId] });
    const ok = await addScopeMembers({ db, scopeId, projectId, cardIds: [cardId] });
    expect(ok).toBe(true);
    const cards = await getAllCardsByScope({ db, scopeId });
    expect(cards).toHaveLength(1);
  });
});

describe("getScopeRelsByCards", () => {
  it("returns empty array for empty cardIds", async () => {
    const { db } = await setup();
    expect(await getScopeRelsByCards({ db, cardIds: [] })).toEqual([]);
  });

  it("returns scope-rel rows for the given cards", async () => {
    const { db, scopeId, cardId } = await setup();
    await addScopeRel({ db, scopeId, cardId });
    const rels = await getScopeRelsByCards({ db, cardIds: [cardId] });
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ scopeId, cardId });
  });
});

describe("removeScopeMembers", () => {
  it("removes all requested cards from the scope", async () => {
    const { db, bundleId, scopeId, cardId } = await setup();
    const c2 = await addCard({ db, bundleId, content: "Card B" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: c2 });

    await removeScopeMembers({ db, scopeId, cardIds: [cardId, c2] });

    expect(await getAllCardsByScope({ db, scopeId })).toEqual([]);
  });
});

describe("removeScopeMembersFromProject", () => {
  it("removes members when every card belongs to the project", async () => {
    const { db, projectId, bundleId, scopeId, cardId } = await setup();
    const c2 = await addCard({ db, bundleId, content: "Card B" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: c2 });

    const ok = await removeScopeMembersFromProject({
      db,
      scopeId,
      projectId,
      cardIds: [cardId, c2],
    });

    expect(ok).toBe(true);
    expect(await getAllCardsByScope({ db, scopeId })).toEqual([]);
  });

  it("does not remove anything when a card belongs to another project", async () => {
    const { db, projectId, scopeId, cardId } = await setup();
    const otherProjectId = await addProject({ db, name: "Other" });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });
    const otherCardId = await addCard({ db, bundleId: otherBundleId, content: "elsewhere" });
    await addScopeRel({ db, scopeId, cardId });
    await addScopeRel({ db, scopeId, cardId: otherCardId });

    const ok = await removeScopeMembersFromProject({
      db,
      scopeId,
      projectId,
      cardIds: [cardId, otherCardId],
    });

    expect(ok).toBe(false);
    expect(await getScopeRelsByCards({ db, cardIds: [cardId, otherCardId] })).toHaveLength(2);
  });
});
