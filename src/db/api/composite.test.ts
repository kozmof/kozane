import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  createCardInTaskspaceContext,
  createCardFromTaskspace,
  deleteProjectCards,
  moveCardsToProject,
  squashProjectCard,
} from "./composite.js";
import { deleteBundleWithReassign, deleteLayerWithReassign } from "./composite.js";
import { addProject } from "./project.js";
import { addBundle, getAllBundles, getBundle } from "./bundle.js";
import { addScope } from "./scope.js";
import { addTaskspace } from "./taskspace.js";
import { addCard, getAllCards, getCard, getCardBundleNames, updateCard } from "./card.js";
import { addScopeRel, getAllCardsByScope } from "./scope-rel.js";
import { BATCH_MAX } from "../../lib/constants.js";
import { getGlueRelsByCards, glueCards } from "./glue.js";
import { glueTable } from "../schema.js";
import { NotFoundError } from "./utils.js";
import { addLayer, getAllLayers, getDefaultLayer, getLayer } from "./layer.js";

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "P" });
  await addLayer({ db, projectId: projectId, name: "Base", isDefault: true });
  const bundleId = await addBundle({ db, projectId, name: "B" });
  const scopeId = await addScope({ db, name: "S" });
  return { db, projectId, bundleId, scopeId };
}

describe("deleteProjectCards", () => {
  it("accepts an empty cardIds array", async () => {
    const { db, projectId } = await setup();
    await expect(deleteProjectCards({ db, projectId, cardIds: [] })).resolves.toEqual({
      ok: true,
    });
  });

  it("deletes all cards when all belong to the project", async () => {
    const { db, projectId, bundleId } = await setup();
    const c1 = await addCard({ db, bundleId, content: "A" });
    const c2 = await addCard({ db, bundleId, content: "B" });

    const ok = await deleteProjectCards({ db, projectId, cardIds: [c1, c2] });

    expect(ok).toEqual({ ok: true });
    expect(await getCard({ db, bundleId, cardId: c1 })).toBeUndefined();
    expect(await getCard({ db, bundleId, cardId: c2 })).toBeUndefined();
  });

  it("names the cards, and deletes none, when one does not belong to the project", async () => {
    const { db, projectId, bundleId } = await setup();
    const ownCard = await addCard({ db, bundleId, content: "Mine" });
    const otherProjectId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherProjectId, name: "Base", isDefault: true });
    const otherBundleId = await addBundle({ db, projectId: otherProjectId, name: "Other" });
    const foreignCard = await addCard({ db, bundleId: otherBundleId, content: "Theirs" });

    const ok = await deleteProjectCards({ db, projectId, cardIds: [ownCard, foreignCard] });

    expect(ok).toEqual({ ok: false, reason: "foreign-cards" });
    expect(await getCard({ db, bundleId, cardId: ownCard })).toBeDefined();
  });

  it("dissolves the glue group when deleting one member of a pair", async () => {
    const { db, projectId, bundleId } = await setup();
    const kept = await addCard({ db, bundleId, content: "Kept" });
    const removed = await addCard({ db, bundleId, content: "Removed" });
    const glueId = await glueCards({ db, cardIds: [kept, removed] });

    await deleteProjectCards({ db, projectId, cardIds: [removed] });

    // The survivor must not be left alone in a group the UI still offers to unglue.
    expect(await getGlueRelsByCards({ db, cardIds: [kept] })).toEqual([]);
    expect(await db.select().from(glueTable).where(eq(glueTable.id, glueId))).toEqual([]);
  });

  it("removes the glue group when deleting every member", async () => {
    const { db, projectId, bundleId } = await setup();
    const c1 = await addCard({ db, bundleId, content: "A" });
    const c2 = await addCard({ db, bundleId, content: "B" });
    await glueCards({ db, cardIds: [c1, c2] });

    await deleteProjectCards({ db, projectId, cardIds: [c1, c2] });

    expect(await db.select().from(glueTable)).toEqual([]);
  });

  it("leaves a three-card group intact when only one member is deleted", async () => {
    const { db, projectId, bundleId } = await setup();
    const c1 = await addCard({ db, bundleId, content: "A" });
    const c2 = await addCard({ db, bundleId, content: "B" });
    const c3 = await addCard({ db, bundleId, content: "C" });
    const glueId = await glueCards({ db, cardIds: [c1, c2, c3] });

    await deleteProjectCards({ db, projectId, cardIds: [c1] });

    const remaining = await getGlueRelsByCards({ db, cardIds: [c2, c3] });
    expect(remaining).toHaveLength(2);
    expect(remaining.every((rel) => rel.glueId === glueId)).toBe(true);
  });
});

// Tests use createCardInTaskspaceContext directly to avoid the withTx in-memory
// connection boundary — createCardFromTaskspace wraps this in a real transaction.
describe("createCardInTaskspaceContext", () => {
  it("creates a card and returns its id", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, projectId, scopeId });
    const cardId = await createCardInTaskspaceContext({
      db,
      taskspaceId: wcId,
      bundleId,
      content: "Hi",
    });
    expect(cardId).toBeTruthy();
  });

  it("card is stored in the correct bundle with the taskspaceId set", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, projectId, scopeId });
    const cardId = await createCardInTaskspaceContext({
      db,
      taskspaceId: wcId,
      bundleId,
      content: "Content",
    });
    const card = await getCard({ db, bundleId, cardId });
    expect(card?.content).toBe("Content");
    expect(card?.taskspaceId).toBe(wcId);
  });

  it("auto-adds the card to the scope when taskspace has a scope", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, projectId, scopeId });
    const cardId = await createCardInTaskspaceContext({
      db,
      taskspaceId: wcId,
      bundleId,
      content: "Scoped",
    });
    const scopeCards = await getAllCardsByScope({ db, scopeId });
    expect(scopeCards.map((c) => c.id)).toContain(cardId);
  });

  it("does NOT add to scope when taskspace has no scope", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, projectId });

    const cardId = await createCardInTaskspaceContext({
      db,
      taskspaceId: wcId,
      bundleId,
      content: "X",
    });

    expect(await getCard({ db, bundleId, cardId })).toBeDefined();
    const scopeCards = await getAllCardsByScope({ db, scopeId });
    expect(scopeCards.map((c) => c.id)).not.toContain(cardId);
  });

  it("throws NotFoundError for a missing taskspaceId", async () => {
    const { db, bundleId } = await setup();
    await expect(
      createCardInTaskspaceContext({ db, taskspaceId: "ghost", bundleId, content: "Hi" }),
    ).rejects.toThrow(NotFoundError);
  });
});

// createCardFromTaskspace wraps the inner logic in a transaction.
// We only verify it resolves (not what the transaction writes) because
// libsql :memory: transactions use a fresh connection internally.
describe("createCardFromTaskspace", () => {
  it("returns a card id", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, projectId, scopeId });
    const cardId = await createCardFromTaskspace({
      db,
      taskspaceId: wcId,
      bundleId,
      content: "Tx",
    });
    expect(typeof cardId).toBe("string");
    expect(cardId.length).toBeGreaterThan(0);
  });

  it("throws NotFoundError for a missing taskspaceId", async () => {
    const { db, bundleId } = await setup();
    await expect(
      createCardFromTaskspace({ db, taskspaceId: "ghost", bundleId, content: "Hi" }),
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

describe("deleteLayerWithReassign", () => {
  it("moves cards to the default layer before deleting the layer", async () => {
    const { db, projectId, bundleId } = await setup();
    const defaultLayer = await getDefaultLayer({ db, projectId });
    const { id: layerId } = await addLayer({ db, projectId, name: "Draft" });
    const cardId = await addCard({ db, bundleId, layerId, content: "Move me" });

    await expect(deleteLayerWithReassign({ db, projectId, layerId })).resolves.toEqual({
      defaultLayerId: defaultLayer!.id,
    });

    expect(await getLayer({ db, projectId, layerId })).toBeUndefined();
    // Reassigned, not cascaded away with the layer.
    expect(await getCard({ db, bundleId, cardId })).toMatchObject({
      content: "Move me",
      layerId: defaultLayer!.id,
    });
  });

  it("throws NotFoundError for a missing layer", async () => {
    const { db, projectId } = await setup();
    await expect(deleteLayerWithReassign({ db, projectId, layerId: "ghost" })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("rejects deleting the default layer", async () => {
    const { db, projectId } = await setup();
    const defaultLayer = await getDefaultLayer({ db, projectId });

    await expect(
      deleteLayerWithReassign({ db, projectId, layerId: defaultLayer!.id }),
    ).rejects.toThrow("Cannot delete the default layer");
  });
});

describe("moveCardsToProject", () => {
  async function setupMove() {
    const db = await createTestDB();
    const srcId = await addProject({ db, name: "Source" });
    await addLayer({ db, projectId: srcId, name: "Base", isDefault: true });
    const dstId = await addProject({ db, name: "Destination" });
    await addLayer({ db, projectId: dstId, name: "Base", isDefault: true });
    const srcBundle = await addBundle({ db, projectId: srcId, name: "General" });
    return { db, srcId, dstId, srcBundle };
  }

  it("accepts an empty cardIds array without touching the DB", async () => {
    const { db, srcId, dstId } = await setupMove();
    await expect(
      moveCardsToProject({ db, sourceProjectId: srcId, targetProjectId: dstId, cardIds: [] }),
    ).resolves.toEqual({ ok: true });
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

    expect(ok).toEqual({ ok: true });
    expect(await getCard({ db, bundleId: dstBundle, cardId })).toMatchObject({ content: "Hello" });
    expect(await getCard({ db, bundleId: srcBundle, cardId })).toBeUndefined();
  });

  it("maps the card onto the same-named layer in the target project", async () => {
    const { db, srcId, dstId, srcBundle } = await setupMove();
    const { id: srcLayer } = await addLayer({ db, projectId: srcId, name: "Draft" });
    const cardId = await addCard({
      db,
      bundleId: srcBundle,
      layerId: srcLayer,
      content: "Layered",
    });

    await moveCardsToProject({
      db,
      sourceProjectId: srcId,
      targetProjectId: dstId,
      cardIds: [cardId],
    });

    // The layer is per-project, so a matching one is created in the target.
    const dstLayers = await getAllLayers({ db, projectId: dstId });
    const dstDraft = dstLayers.find(({ name }) => name === "Draft");
    expect(dstDraft).toBeDefined();
    const dstBundles = await getAllBundles({ db, projectId: dstId });
    expect(await getCard({ db, bundleId: dstBundles[0].id, cardId })).toMatchObject({
      layerId: dstDraft!.id,
    });
  });

  it("reuses an existing same-named layer in the target project", async () => {
    const { db, srcId, dstId, srcBundle } = await setupMove();
    const { id: srcLayer } = await addLayer({ db, projectId: srcId, name: "Draft" });
    const { id: dstLayer } = await addLayer({ db, projectId: dstId, name: "Draft" });
    const cardId = await addCard({ db, bundleId: srcBundle, layerId: srcLayer, content: "Reuse" });

    await moveCardsToProject({
      db,
      sourceProjectId: srcId,
      targetProjectId: dstId,
      cardIds: [cardId],
    });

    expect(await getAllLayers({ db, projectId: dstId })).toHaveLength(2);
    const dstBundles = await getAllBundles({ db, projectId: dstId });
    expect(await getCard({ db, bundleId: dstBundles[0].id, cardId })).toMatchObject({
      layerId: dstLayer,
    });
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

    expect(ok).toEqual({ ok: true });
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

  it("names the cards when any does not belong to the source project", async () => {
    const { db, srcId, dstId, srcBundle } = await setupMove();
    const ownCard = await addCard({ db, bundleId: srcBundle, content: "Mine" });
    const otherId = await addProject({ db, name: "Third" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreignCard = await addCard({ db, bundleId: otherBundle, content: "Not mine" });

    const ok = await moveCardsToProject({
      db,
      sourceProjectId: srcId,
      targetProjectId: dstId,
      cardIds: [ownCard, foreignCard],
    });

    expect(ok).toEqual({ ok: false, reason: "foreign-cards" });
    // own card must remain in source (transaction rolled back)
    const rows = await getCardBundleNames({ db, cardIds: [ownCard] });
    expect(rows[0].bundleId).toBe(srcBundle);
  });
});

describe("squashProjectCard", () => {
  const CANVAS = { canvasWidth: 5600, canvasHeight: 4000 };

  async function squashSetup() {
    const base = await setup();
    const cardId = await addCard({
      db: base.db,
      bundleId: base.bundleId,
      content: "First thought. Second thought. 第三の考え。",
      posX: 1000,
      posY: 500,
      zIndex: 7,
    });
    return { ...base, cardId };
  }

  it("replaces the card with one card per segment", async () => {
    const { db, projectId, bundleId, cardId } = await squashSetup();

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cards.map(({ content }) => content)).toEqual([
      "First thought",
      "Second thought",
      "第三の考え",
    ]);
    expect(await getCard({ db, bundleId, cardId })).toBeUndefined();
    expect(await getAllCards({ db, bundleId })).toHaveLength(3);
  });

  it("lays the pieces out from where the card sat, the first one in its place", async () => {
    const { db, projectId, cardId } = await squashSetup();

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result.ok && result.cards.map(({ posX, posY }) => ({ posX, posY }))).toEqual([
      { posX: 1000, posY: 500 },
      { posX: 1280, posY: 500 },
      { posX: 1560, posY: 500 },
    ]);
  });

  it("skips a slot another card already sits on", async () => {
    const { db, projectId, bundleId, cardId } = await squashSetup();
    await addCard({ db, bundleId, content: "In the way", posX: 1280, posY: 500 });

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result.ok && result.cards.map(({ posX }) => posX)).toEqual([1000, 1560, 1840]);
  });

  it("gives the pieces the card's bundle, layer, taskspace, width, and stacking", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const layerId = (await getDefaultLayer({ db, projectId }))!.id;
    const taskspaceId = await addTaskspace({ db, name: "T", scopeId, path: "/tmp/t" });
    const cardId = await addCard({
      db,
      bundleId,
      layerId,
      taskspaceId,
      content: "One. Two",
      zIndex: 4,
    });
    await updateCard({ db, cardId, bundleId, width: 320 });

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const card of result.cards) {
      expect(card.bundleId).toBe(bundleId);
      expect(card.layerId).toBe(layerId);
      expect(card.taskspaceId).toBe(taskspaceId);
      expect(card.width).toBe(320);
    }
    // In the order the text reads, above whatever the source sat above.
    expect(result.cards.map(({ zIndex }) => zIndex)).toEqual([4, 5]);
  });

  /**
   * What the pieces do *not* inherit is the source card's history: each is a new card,
   * created when the squash ran. They do share one moment with each other, so `kozane card
   * list --sort created` cannot separate pieces of one squash by a second's drift.
   */
  it("stamps every piece as new, at one moment", async () => {
    const { db, projectId, cardId } = await squashSetup();

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const moments = new Set(result.cards.map(({ createdAt }) => createdAt.getTime()));
    expect(moments.size).toBe(1);
    for (const card of result.cards)
      expect(card.updatedAt.getTime()).toBe(card.createdAt.getTime());
  });

  it("gathers the pieces into every scope the card was in", async () => {
    const { db, projectId, bundleId, scopeId, cardId } = await squashSetup();
    await addScopeRel({ db, scopeId, cardId });

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    const gathered = await getAllCardsByScope({ db, scopeId });
    expect(gathered.map(({ id }) => id).sort()).toEqual(
      (result.ok ? result.cards.map(({ id }) => id) : []).sort(),
    );
    expect(await getAllCards({ db, bundleId })).toHaveLength(3);
  });

  it("dissolves the glue group the card leaves behind", async () => {
    const { db, projectId, bundleId, cardId } = await squashSetup();
    const partner = await addCard({ db, bundleId, content: "Partner" });
    const glueId = await glueCards({ db, cardIds: [cardId, partner] });

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    // The partner must not be left alone in a group the UI still offers to unglue, and the
    // pieces are one card's worth of text rather than a group someone arranged.
    expect(await getGlueRelsByCards({ db, cardIds: [partner] })).toEqual([]);
    expect(await db.select().from(glueTable).where(eq(glueTable.id, glueId))).toEqual([]);
  });

  it("refuses a card whose text yields a single segment, leaving it alone", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({ db, bundleId, content: "One indivisible thought" });

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result).toEqual({ ok: false, reason: "indivisible" });
    expect(await getCard({ db, bundleId, cardId })).toBeDefined();
  });

  it("refuses a card that belongs to another project", async () => {
    const { db, projectId } = await setup();
    const otherId = await addProject({ db, name: "Other" });
    await addLayer({ db, projectId: otherId, name: "Base", isDefault: true });
    const otherBundle = await addBundle({ db, projectId: otherId, name: "X" });
    const foreign = await addCard({ db, bundleId: otherBundle, content: "One. Two" });

    const result = await squashProjectCard({ db, projectId, cardId: foreign, ...CANVAS });

    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(await getCard({ db, bundleId: otherBundle, cardId: foreign })).toBeDefined();
  });

  it("creates a set too large for one insert statement", async () => {
    const { db, projectId, bundleId, scopeId } = await setup();
    const cardId = await addCard({
      db,
      bundleId,
      content: Array.from({ length: 250 }, (_, i) => `Piece ${i}`).join(". "),
    });
    await addScopeRel({ db, scopeId, cardId });

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result.ok && result.cards).toHaveLength(250);
    expect(await getAllCards({ db, bundleId })).toHaveLength(250);
    // The scope memberships are batched the same way the cards are.
    expect(await getAllCardsByScope({ db, scopeId })).toHaveLength(250);
  });

  it("refuses a card that would split into more cards than one request may carry", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({
      db,
      bundleId,
      content: Array.from({ length: BATCH_MAX + 1 }, (_, i) => `Piece ${i}`).join(". "),
    });

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result).toEqual({ ok: false, reason: "too-many" });
    expect(await getCard({ db, bundleId, cardId })).toBeDefined();
  });

  it("keeps the pieces on the board when the card sits against its edge", async () => {
    const { db, projectId, bundleId } = await setup();
    const cardId = await addCard({
      db,
      bundleId,
      content: "One. Two. Three",
      posX: CANVAS.canvasWidth - 10,
      posY: CANVAS.canvasHeight,
    });

    const result = await squashProjectCard({ db, projectId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const { posX, posY } of result.cards) {
      expect(posX).toBeLessThanOrEqual(CANVAS.canvasWidth);
      expect(posY).toBeLessThanOrEqual(CANVAS.canvasHeight);
    }
  });
});
