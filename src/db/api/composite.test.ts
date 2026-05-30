import { describe, it, expect } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import {
  createCardInWorkingCopyContext,
  createCardFromWorkingCopy,
  moveCardsToProject,
} from "./composite.js";
import { deleteBundleWithReassign } from "./composite.js";
import { addProject } from "./project.js";
import { addBundle, getAllBundles, getBundle } from "./bundle.js";
import { addScope } from "./scope.js";
import { addWorkingCopy } from "./working-copy.js";
import { addCard, getAllCards, getCard, getCardBundleNames } from "./card.js";
import { getAllCardsByScope } from "./scope-rel.js";
import { NotFoundError } from "./utils.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  const scopeId = await addScope({ db, name: "S" });
  return { db, projectId, bundleId, scopeId };
}

// Tests use createCardInWorkingCopyContext directly to avoid the withTx in-memory
// connection boundary — createCardFromWorkingCopy wraps this in a real transaction.
describe("createCardInWorkingCopyContext", () => {
  it("creates a card and returns its id", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addWorkingCopy({ db, projectId, scopeId });
    const cardId = await createCardInWorkingCopyContext({
      db,
      workingCopyId: wcId,
      bundleId,
      content: "Hi",
    });
    expect(cardId).toBeTruthy();
  });

  it("card is stored in the correct bundle with the workingCopyId set", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addWorkingCopy({ db, projectId, scopeId });
    const cardId = await createCardInWorkingCopyContext({
      db,
      workingCopyId: wcId,
      bundleId,
      content: "Content",
    });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("Content");
    expect(card?.workingCopyId).toBe(wcId);
  });

  it("auto-adds the card to the scope when working copy has a scope", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addWorkingCopy({ db, projectId, scopeId });
    const cardId = await createCardInWorkingCopyContext({
      db,
      workingCopyId: wcId,
      bundleId,
      content: "Scoped",
    });
    const scopeCards = await getAllCardsByScope({ db, scopeId });
    expect(scopeCards.map((c) => c.id)).toContain(cardId);
  });

  it("does NOT add to scope when working copy has no scope", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addWorkingCopy({ db, projectId });

    const cardId = await createCardInWorkingCopyContext({
      db,
      workingCopyId: wcId,
      bundleId,
      content: "X",
    });

    expect(await getCard({ db, bundleId, cardId })).toBeDefined();
    const scopeCards = await getAllCardsByScope({ db, scopeId });
    expect(scopeCards.map((c) => c.id)).not.toContain(cardId);
  });

  it("throws NotFoundError for a missing workingCopyId", async () => {
    const { db, bundleId } = await setup();
    await expect(
      createCardInWorkingCopyContext({ db, workingCopyId: "ghost", bundleId, content: "Hi" }),
    ).rejects.toThrow(NotFoundError);
  });
});

// createCardFromWorkingCopy wraps the inner logic in a transaction.
// We only verify it resolves (not what the transaction writes) because
// libsql :memory: transactions use a fresh connection internally.
describe("createCardFromWorkingCopy", () => {
  it("returns a card id", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addWorkingCopy({ db, projectId, scopeId });
    const cardId = await createCardFromWorkingCopy({
      db,
      workingCopyId: wcId,
      bundleId,
      content: "Tx",
    });
    expect(typeof cardId).toBe("string");
    expect(cardId.length).toBeGreaterThan(0);
  });

  it("throws NotFoundError for a missing workingCopyId", async () => {
    const { db, bundleId } = await setup();
    await expect(
      createCardFromWorkingCopy({ db, workingCopyId: "ghost", bundleId, content: "Hi" }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("deleteBundleWithReassign", () => {
  it("reassigns cards to the default bundle before deleting the bundle", async () => {
    const { db, projectId } = await setup();
    const defaultBundleId = await addBundle({
      db,
      projectId,
      name: "Default",
      isDefault: true,
    });
    const bundleId = await addBundle({ db, projectId, name: "Feature" });
    const cardId = await addCard({ db, bundleId, content: "Move me" });

    await expect(deleteBundleWithReassign({ db, projectId, bundleId })).resolves.toEqual({
      defaultBundleId,
    });

    expect(await getBundle({ db, projectId, bundleId })).toBeUndefined();
    expect((await getCard({ db, bundleId: defaultBundleId, cardId }))?.content).toBe("Move me");
    expect(await getAllCards({ db, bundleId })).toEqual([]);
  });

  it("throws NotFoundError for a missing bundle", async () => {
    const { db, projectId } = await setup();
    await expect(deleteBundleWithReassign({ db, projectId, bundleId: "ghost" })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("rejects deleting the default bundle", async () => {
    const { db, projectId } = await setup();
    const defaultBundleId = await addBundle({
      db,
      projectId,
      name: "Default",
      isDefault: true,
    });

    await expect(
      deleteBundleWithReassign({ db, projectId, bundleId: defaultBundleId }),
    ).rejects.toThrow("Cannot delete the default bundle");
  });

  it("throws when no default bundle exists", async () => {
    const { db, projectId, bundleId } = await setup();
    await expect(deleteBundleWithReassign({ db, projectId, bundleId })).rejects.toThrow(
      "No default bundle found for this project",
    );
  });
});

describe("moveCardsToProject", () => {
  async function setupMove() {
    const db = await createTestDB();
    const srcId = await addProject({ db, name: "Source" });
    const dstId = await addProject({ db, name: "Destination" });
    const srcBundle = await addBundle({ db, projectId: srcId, name: "General" });
    return { db, srcId, dstId, srcBundle };
  }

  it("returns true for an empty cardIds array without touching the DB", async () => {
    const { db, srcId, dstId } = await setupMove();
    await expect(
      moveCardsToProject({ db, sourceProjectId: srcId, targetProjectId: dstId, cardIds: [] }),
    ).resolves.toBe(true);
  });

  it("moves a card to an existing same-name bundle in the target project", async () => {
    const { db, srcId, dstId, srcBundle } = await setupMove();
    const dstBundle = await addBundle({ db, projectId: dstId, name: "General" });
    const cardId = await addCard({ db, bundleId: srcBundle, content: "Hello" });

    const ok = await moveCardsToProject({
      db,
      sourceProjectId: srcId,
      targetProjectId: dstId,
      cardIds: [cardId],
    });

    expect(ok).toBe(true);
    expect(await getCard({ db, bundleId: dstBundle, cardId })).toMatchObject({ content: "Hello" });
    expect(await getCard({ db, bundleId: srcBundle, cardId })).toBeUndefined();
  });

  it("creates a new bundle in the target project when no name match exists", async () => {
    const { db, srcId, dstId, srcBundle } = await setupMove();
    const cardId = await addCard({ db, bundleId: srcBundle, content: "New bundle card" });

    const ok = await moveCardsToProject({
      db,
      sourceProjectId: srcId,
      targetProjectId: dstId,
      cardIds: [cardId],
    });

    expect(ok).toBe(true);
    const dstBundles = await getAllBundles({ db, projectId: dstId });
    expect(dstBundles).toHaveLength(1);
    expect(dstBundles[0].name).toBe("General");
    expect(await getCard({ db, bundleId: dstBundles[0].id, cardId })).toMatchObject({
      content: "New bundle card",
    });
  });

  it("routes cards from different source bundles to their own named bundles in target", async () => {
    const { db, srcId, dstId, srcBundle } = await setupMove();
    const srcBundle2 = await addBundle({ db, projectId: srcId, name: "Research" });
    const c1 = await addCard({ db, bundleId: srcBundle, content: "General card" });
    const c2 = await addCard({ db, bundleId: srcBundle2, content: "Research card" });

    await moveCardsToProject({
      db,
      sourceProjectId: srcId,
      targetProjectId: dstId,
      cardIds: [c1, c2],
    });

    const dstBundles = await getAllBundles({ db, projectId: dstId });
    const dstGeneral = dstBundles.find((b) => b.name === "General")!;
    const dstResearch = dstBundles.find((b) => b.name === "Research")!;
    expect(dstGeneral).toBeDefined();
    expect(dstResearch).toBeDefined();
    expect(await getCard({ db, bundleId: dstGeneral.id, cardId: c1 })).toMatchObject({
      content: "General card",
    });
    expect(await getCard({ db, bundleId: dstResearch.id, cardId: c2 })).toMatchObject({
      content: "Research card",
    });
  });

  it("does not create a duplicate target bundle when two source cards share a bundle name", async () => {
    const { db, srcId, dstId, srcBundle } = await setupMove();
    const c1 = await addCard({ db, bundleId: srcBundle, content: "Card 1" });
    const c2 = await addCard({ db, bundleId: srcBundle, content: "Card 2" });

    await moveCardsToProject({
      db,
      sourceProjectId: srcId,
      targetProjectId: dstId,
      cardIds: [c1, c2],
    });

    const dstBundles = await getAllBundles({ db, projectId: dstId });
    expect(dstBundles).toHaveLength(1);
  });

  it("returns false when any card does not belong to the source project", async () => {
    const { db, srcId, dstId, srcBundle } = await setupMove();
    const ownCard = await addCard({ db, bundleId: srcBundle, content: "Mine" });
    const otherId = await addProject({ db, name: "Third" });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Not mine" });

    const ok = await moveCardsToProject({
      db,
      sourceProjectId: srcId,
      targetProjectId: dstId,
      cardIds: [ownCard, foreignCard],
    });

    expect(ok).toBe(false);
    // own card must remain in source (transaction rolled back)
    const rows = await getCardBundleNames({ db, cardIds: [ownCard] });
    expect(rows[0].bundleId).toBe(srcBundle);
  });
});
