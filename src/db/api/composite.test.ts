import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  createCardInTaskspaceContext,
  createCardFromTaskspace,
  deleteNamespaceCards,
  moveCardsToNamespace,
  squashNamespaceCard,
} from "./composite.js";
import { deletePartitionWithReassign, deleteLayerWithReassign } from "./composite.js";
import { addNamespace } from "./namespace.js";
import { addPartition, getAllPartitions, getPartition } from "./partition.js";
import { addScope } from "./scope.js";
import { addTaskspace } from "./taskspace.js";
import { addCard, getAllCards, getCard, getCardPartitionNames, updateCard } from "./card.js";
import { addScopeRel, getAllCardsByScope } from "./scope-rel.js";
import { BATCH_MAX } from "../../lib/constants.js";
import { getGlueRelsByCards, glueCards } from "./glue.js";
import { glueTable } from "../schema.js";
import { NotFoundError } from "./utils.js";
import { addLayer, getAllLayers, getDefaultLayer, getLayer } from "./layer.js";

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "P" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "B" });
  const scopeId = await addScope({ db, name: "S" });
  return { db, namespaceId, partitionId, scopeId };
}

describe("deleteNamespaceCards", () => {
  it("accepts an empty cardIds array", async () => {
    const { db, namespaceId } = await setup();
    await expect(deleteNamespaceCards({ db, namespaceId, cardIds: [] })).resolves.toEqual({
      ok: true,
    });
  });

  it("deletes all cards when all belong to the namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const c1 = await addCard({ db, partitionId, content: "A" });
    const c2 = await addCard({ db, partitionId, content: "B" });

    const ok = await deleteNamespaceCards({ db, namespaceId, cardIds: [c1, c2] });

    expect(ok).toEqual({ ok: true });
    expect(await getCard({ db, partitionId, cardId: c1 })).toBeUndefined();
    expect(await getCard({ db, partitionId, cardId: c2 })).toBeUndefined();
  });

  it("names the cards, and deletes none, when one does not belong to the namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const ownCard = await addCard({ db, partitionId, content: "Mine" });
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Other",
    });
    const foreignCard = await addCard({ db, partitionId: otherPartitionId, content: "Theirs" });

    const ok = await deleteNamespaceCards({ db, namespaceId, cardIds: [ownCard, foreignCard] });

    expect(ok).toEqual({ ok: false, reason: "foreign-cards" });
    expect(await getCard({ db, partitionId, cardId: ownCard })).toBeDefined();
  });

  it("dissolves the glue group when deleting one member of a pair", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const kept = await addCard({ db, partitionId, content: "Kept" });
    const removed = await addCard({ db, partitionId, content: "Removed" });
    const glueId = await glueCards({ db, cardIds: [kept, removed] });

    await deleteNamespaceCards({ db, namespaceId, cardIds: [removed] });

    // The survivor must not be left alone in a group the UI still offers to unglue.
    expect(await getGlueRelsByCards({ db, cardIds: [kept] })).toEqual([]);
    expect(await db.select().from(glueTable).where(eq(glueTable.id, glueId))).toEqual([]);
  });

  it("removes the glue group when deleting every member", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const c1 = await addCard({ db, partitionId, content: "A" });
    const c2 = await addCard({ db, partitionId, content: "B" });
    await glueCards({ db, cardIds: [c1, c2] });

    await deleteNamespaceCards({ db, namespaceId, cardIds: [c1, c2] });

    expect(await db.select().from(glueTable)).toEqual([]);
  });

  it("leaves a three-card group intact when only one member is deleted", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const c1 = await addCard({ db, partitionId, content: "A" });
    const c2 = await addCard({ db, partitionId, content: "B" });
    const c3 = await addCard({ db, partitionId, content: "C" });
    const glueId = await glueCards({ db, cardIds: [c1, c2, c3] });

    await deleteNamespaceCards({ db, namespaceId, cardIds: [c1] });

    const remaining = await getGlueRelsByCards({ db, cardIds: [c2, c3] });
    expect(remaining).toHaveLength(2);
    expect(remaining.every((rel) => rel.glueId === glueId)).toBe(true);
  });
});

// Tests use createCardInTaskspaceContext directly to avoid the withTx in-memory
// connection boundary — createCardFromTaskspace wraps this in a real transaction.
describe("createCardInTaskspaceContext", () => {
  it("creates a card and returns its id", async () => {
    const { db, namespaceId, partitionId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, namespaceId, scopeId });
    const cardId = await createCardInTaskspaceContext({
      db,
      taskspaceId: wcId,
      partitionId,
      content: "Hi",
    });
    expect(cardId).toBeTruthy();
  });

  it("card is stored in the correct partition with the taskspaceId set", async () => {
    const { db, namespaceId, partitionId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, namespaceId, scopeId });
    const cardId = await createCardInTaskspaceContext({
      db,
      taskspaceId: wcId,
      partitionId,
      content: "Content",
    });
    const card = await getCard({ db, partitionId, cardId });
    expect(card?.content).toBe("Content");
    expect(card?.taskspaceId).toBe(wcId);
  });

  it("auto-adds the card to the scope when taskspace has a scope", async () => {
    const { db, namespaceId, partitionId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, namespaceId, scopeId });
    const cardId = await createCardInTaskspaceContext({
      db,
      taskspaceId: wcId,
      partitionId,
      content: "Scoped",
    });
    const scopeCards = await getAllCardsByScope({ db, scopeId });
    expect(scopeCards.map((c) => c.id)).toContain(cardId);
  });

  it("does NOT add to scope when taskspace has no scope", async () => {
    const { db, namespaceId, partitionId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, namespaceId });

    const cardId = await createCardInTaskspaceContext({
      db,
      taskspaceId: wcId,
      partitionId,
      content: "X",
    });

    expect(await getCard({ db, partitionId, cardId })).toBeDefined();
    const scopeCards = await getAllCardsByScope({ db, scopeId });
    expect(scopeCards.map((c) => c.id)).not.toContain(cardId);
  });

  it("throws NotFoundError for a missing taskspaceId", async () => {
    const { db, partitionId } = await setup();
    await expect(
      createCardInTaskspaceContext({ db, taskspaceId: "ghost", partitionId, content: "Hi" }),
    ).rejects.toThrow(NotFoundError);
  });
});

// createCardFromTaskspace wraps the inner logic in a transaction.
// We only verify it resolves (not what the transaction writes) because
// libsql :memory: transactions use a fresh connection internally.
describe("createCardFromTaskspace", () => {
  it("returns a card id", async () => {
    const { db, namespaceId, partitionId, scopeId } = await setup();
    const wcId = await addTaskspace({ db, namespaceId, scopeId });
    const cardId = await createCardFromTaskspace({
      db,
      taskspaceId: wcId,
      partitionId,
      content: "Tx",
    });
    expect(typeof cardId).toBe("string");
    expect(cardId.length).toBeGreaterThan(0);
  });

  it("throws NotFoundError for a missing taskspaceId", async () => {
    const { db, partitionId } = await setup();
    await expect(
      createCardFromTaskspace({ db, taskspaceId: "ghost", partitionId, content: "Hi" }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("deletePartitionWithReassign", () => {
  it("reassigns cards to the default partition before deleting the partition", async () => {
    const { db, namespaceId } = await setup();
    const defaultPartitionId = await addPartition({
      db,
      namespaceId,
      name: "Default",
      isDefault: true,
    });
    const partitionId = await addPartition({ db, namespaceId, name: "Feature" });
    const cardId = await addCard({ db, partitionId, content: "Move me" });

    await expect(deletePartitionWithReassign({ db, namespaceId, partitionId })).resolves.toEqual({
      defaultPartitionId,
    });

    expect(await getPartition({ db, namespaceId, partitionId })).toBeUndefined();
    expect((await getCard({ db, partitionId: defaultPartitionId, cardId }))?.content).toBe(
      "Move me",
    );
    expect(await getAllCards({ db, partitionId })).toEqual([]);
  });

  it("throws NotFoundError for a missing partition", async () => {
    const { db, namespaceId } = await setup();
    await expect(
      deletePartitionWithReassign({ db, namespaceId, partitionId: "ghost" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects deleting the default partition", async () => {
    const { db, namespaceId } = await setup();
    const defaultPartitionId = await addPartition({
      db,
      namespaceId,
      name: "Default",
      isDefault: true,
    });

    await expect(
      deletePartitionWithReassign({ db, namespaceId, partitionId: defaultPartitionId }),
    ).rejects.toThrow("Cannot delete the default partition");
  });

  it("throws when no default partition exists", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await expect(deletePartitionWithReassign({ db, namespaceId, partitionId })).rejects.toThrow(
      "No default partition found for this namespace",
    );
  });
});

describe("deleteLayerWithReassign", () => {
  it("moves cards to the default layer before deleting the layer", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const defaultLayer = await getDefaultLayer({ db, namespaceId });
    const { id: layerId } = await addLayer({ db, namespaceId, name: "Draft" });
    const cardId = await addCard({ db, partitionId, layerId, content: "Move me" });

    await expect(deleteLayerWithReassign({ db, namespaceId, layerId })).resolves.toEqual({
      defaultLayerId: defaultLayer!.id,
    });

    expect(await getLayer({ db, namespaceId, layerId })).toBeUndefined();
    // Reassigned, not cascaded away with the layer.
    expect(await getCard({ db, partitionId, cardId })).toMatchObject({
      content: "Move me",
      layerId: defaultLayer!.id,
    });
  });

  it("throws NotFoundError for a missing layer", async () => {
    const { db, namespaceId } = await setup();
    await expect(deleteLayerWithReassign({ db, namespaceId, layerId: "ghost" })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("rejects deleting the default layer", async () => {
    const { db, namespaceId } = await setup();
    const defaultLayer = await getDefaultLayer({ db, namespaceId });

    await expect(
      deleteLayerWithReassign({ db, namespaceId, layerId: defaultLayer!.id }),
    ).rejects.toThrow("Cannot delete the default layer");
  });
});

describe("moveCardsToNamespace", () => {
  async function setupMove() {
    const db = await createTestDB();
    const srcId = await addNamespace({ db, name: "Source" });
    await addLayer({ db, namespaceId: srcId, name: "Base", isDefault: true });
    const dstId = await addNamespace({ db, name: "Destination" });
    await addLayer({ db, namespaceId: dstId, name: "Base", isDefault: true });
    const srcPartition = await addPartition({ db, namespaceId: srcId, name: "General" });
    return { db, srcId, dstId, srcPartition };
  }

  it("accepts an empty cardIds array without touching the DB", async () => {
    const { db, srcId, dstId } = await setupMove();
    await expect(
      moveCardsToNamespace({ db, sourceNamespaceId: srcId, targetNamespaceId: dstId, cardIds: [] }),
    ).resolves.toEqual({ ok: true });
  });

  it("moves a card to an existing same-name partition in the target namespace", async () => {
    const { db, srcId, dstId, srcPartition } = await setupMove();
    const dstPartition = await addPartition({ db, namespaceId: dstId, name: "General" });
    const cardId = await addCard({ db, partitionId: srcPartition, content: "Hello" });

    const ok = await moveCardsToNamespace({
      db,
      sourceNamespaceId: srcId,
      targetNamespaceId: dstId,
      cardIds: [cardId],
    });

    expect(ok).toEqual({ ok: true });
    expect(await getCard({ db, partitionId: dstPartition, cardId })).toMatchObject({
      content: "Hello",
    });
    expect(await getCard({ db, partitionId: srcPartition, cardId })).toBeUndefined();
  });

  it("maps the card onto the same-named layer in the target namespace", async () => {
    const { db, srcId, dstId, srcPartition } = await setupMove();
    const { id: srcLayer } = await addLayer({ db, namespaceId: srcId, name: "Draft" });
    const cardId = await addCard({
      db,
      partitionId: srcPartition,
      layerId: srcLayer,
      content: "Layered",
    });

    await moveCardsToNamespace({
      db,
      sourceNamespaceId: srcId,
      targetNamespaceId: dstId,
      cardIds: [cardId],
    });

    // The layer is per-namespace, so a matching one is created in the target.
    const dstLayers = await getAllLayers({ db, namespaceId: dstId });
    const dstDraft = dstLayers.find(({ name }) => name === "Draft");
    expect(dstDraft).toBeDefined();
    const dstPartitions = await getAllPartitions({ db, namespaceId: dstId });
    expect(await getCard({ db, partitionId: dstPartitions[0].id, cardId })).toMatchObject({
      layerId: dstDraft!.id,
    });
  });

  it("reuses an existing same-named layer in the target namespace", async () => {
    const { db, srcId, dstId, srcPartition } = await setupMove();
    const { id: srcLayer } = await addLayer({ db, namespaceId: srcId, name: "Draft" });
    const { id: dstLayer } = await addLayer({ db, namespaceId: dstId, name: "Draft" });
    const cardId = await addCard({
      db,
      partitionId: srcPartition,
      layerId: srcLayer,
      content: "Reuse",
    });

    await moveCardsToNamespace({
      db,
      sourceNamespaceId: srcId,
      targetNamespaceId: dstId,
      cardIds: [cardId],
    });

    expect(await getAllLayers({ db, namespaceId: dstId })).toHaveLength(2);
    const dstPartitions = await getAllPartitions({ db, namespaceId: dstId });
    expect(await getCard({ db, partitionId: dstPartitions[0].id, cardId })).toMatchObject({
      layerId: dstLayer,
    });
  });

  it("creates a new partition in the target namespace when no name match exists", async () => {
    const { db, srcId, dstId, srcPartition } = await setupMove();
    const cardId = await addCard({ db, partitionId: srcPartition, content: "New partition card" });

    const ok = await moveCardsToNamespace({
      db,
      sourceNamespaceId: srcId,
      targetNamespaceId: dstId,
      cardIds: [cardId],
    });

    expect(ok).toEqual({ ok: true });
    const dstPartitions = await getAllPartitions({ db, namespaceId: dstId });
    expect(dstPartitions).toHaveLength(1);
    expect(dstPartitions[0].name).toBe("General");
    expect(await getCard({ db, partitionId: dstPartitions[0].id, cardId })).toMatchObject({
      content: "New partition card",
    });
  });

  it("routes cards from different source partitions to their own named partitions in target", async () => {
    const { db, srcId, dstId, srcPartition } = await setupMove();
    const srcPartition2 = await addPartition({ db, namespaceId: srcId, name: "Research" });
    const c1 = await addCard({ db, partitionId: srcPartition, content: "General card" });
    const c2 = await addCard({ db, partitionId: srcPartition2, content: "Research card" });

    await moveCardsToNamespace({
      db,
      sourceNamespaceId: srcId,
      targetNamespaceId: dstId,
      cardIds: [c1, c2],
    });

    const dstPartitions = await getAllPartitions({ db, namespaceId: dstId });
    const dstGeneral = dstPartitions.find((b) => b.name === "General")!;
    const dstResearch = dstPartitions.find((b) => b.name === "Research")!;
    expect(dstGeneral).toBeDefined();
    expect(dstResearch).toBeDefined();
    expect(await getCard({ db, partitionId: dstGeneral.id, cardId: c1 })).toMatchObject({
      content: "General card",
    });
    expect(await getCard({ db, partitionId: dstResearch.id, cardId: c2 })).toMatchObject({
      content: "Research card",
    });
  });

  it("does not create a duplicate target partition when two source cards share a partition name", async () => {
    const { db, srcId, dstId, srcPartition } = await setupMove();
    const c1 = await addCard({ db, partitionId: srcPartition, content: "Card 1" });
    const c2 = await addCard({ db, partitionId: srcPartition, content: "Card 2" });

    await moveCardsToNamespace({
      db,
      sourceNamespaceId: srcId,
      targetNamespaceId: dstId,
      cardIds: [c1, c2],
    });

    const dstPartitions = await getAllPartitions({ db, namespaceId: dstId });
    expect(dstPartitions).toHaveLength(1);
  });

  it("names the cards when any does not belong to the source namespace", async () => {
    const { db, srcId, dstId, srcPartition } = await setupMove();
    const ownCard = await addCard({ db, partitionId: srcPartition, content: "Mine" });
    const otherId = await addNamespace({ db, name: "Third" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreignCard = await addCard({ db, partitionId: otherPartition, content: "Not mine" });

    const ok = await moveCardsToNamespace({
      db,
      sourceNamespaceId: srcId,
      targetNamespaceId: dstId,
      cardIds: [ownCard, foreignCard],
    });

    expect(ok).toEqual({ ok: false, reason: "foreign-cards" });
    // own card must remain in source (transaction rolled back)
    const rows = await getCardPartitionNames({ db, cardIds: [ownCard] });
    expect(rows[0].partitionId).toBe(srcPartition);
  });
});

describe("squashNamespaceCard", () => {
  const CANVAS = { canvasWidth: 5600, canvasHeight: 4000 };

  async function squashSetup() {
    const base = await setup();
    const cardId = await addCard({
      db: base.db,
      partitionId: base.partitionId,
      content: "First thought. Second thought. 第三の考え。",
      posX: 1000,
      posY: 500,
      zIndex: 7,
    });
    return { ...base, cardId };
  }

  it("replaces the card with one card per segment", async () => {
    const { db, namespaceId, partitionId, cardId } = await squashSetup();

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cards.map(({ content }) => content)).toEqual([
      "First thought",
      "Second thought",
      "第三の考え",
    ]);
    expect(await getCard({ db, partitionId, cardId })).toBeUndefined();
    expect(await getAllCards({ db, partitionId })).toHaveLength(3);
  });

  it("lays the pieces out from where the card sat, the first one in its place", async () => {
    const { db, namespaceId, cardId } = await squashSetup();

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result.ok && result.cards.map(({ posX, posY }) => ({ posX, posY }))).toEqual([
      { posX: 1000, posY: 500 },
      { posX: 1280, posY: 500 },
      { posX: 1560, posY: 500 },
    ]);
  });

  it("skips a slot another card already sits on", async () => {
    const { db, namespaceId, partitionId, cardId } = await squashSetup();
    await addCard({ db, partitionId, content: "In the way", posX: 1280, posY: 500 });

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result.ok && result.cards.map(({ posX }) => posX)).toEqual([1000, 1560, 1840]);
  });

  it("gives the pieces the card's partition, layer, taskspace, width, and stacking", async () => {
    const { db, namespaceId, partitionId, scopeId } = await setup();
    const layerId = (await getDefaultLayer({ db, namespaceId }))!.id;
    const taskspaceId = await addTaskspace({ db, name: "T", scopeId, path: "/tmp/t" });
    const cardId = await addCard({
      db,
      partitionId,
      layerId,
      taskspaceId,
      content: "One. Two",
      zIndex: 4,
    });
    await updateCard({ db, cardId, partitionId, width: 320 });

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const card of result.cards) {
      expect(card.partitionId).toBe(partitionId);
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
    const { db, namespaceId, cardId } = await squashSetup();

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const moments = new Set(result.cards.map(({ createdAt }) => createdAt.getTime()));
    expect(moments.size).toBe(1);
    for (const card of result.cards)
      expect(card.updatedAt.getTime()).toBe(card.createdAt.getTime());
  });

  it("gathers the pieces into every scope the card was in", async () => {
    const { db, namespaceId, partitionId, scopeId, cardId } = await squashSetup();
    await addScopeRel({ db, scopeId, cardId });

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    const gathered = await getAllCardsByScope({ db, scopeId });
    expect(gathered.map(({ id }) => id).sort()).toEqual(
      (result.ok ? result.cards.map(({ id }) => id) : []).sort(),
    );
    expect(await getAllCards({ db, partitionId })).toHaveLength(3);
  });

  it("dissolves the glue group the card leaves behind", async () => {
    const { db, namespaceId, partitionId, cardId } = await squashSetup();
    const partner = await addCard({ db, partitionId, content: "Partner" });
    const glueId = await glueCards({ db, cardIds: [cardId, partner] });

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    // The partner must not be left alone in a group the UI still offers to unglue, and the
    // pieces are one card's worth of text rather than a group someone arranged.
    expect(await getGlueRelsByCards({ db, cardIds: [partner] })).toEqual([]);
    expect(await db.select().from(glueTable).where(eq(glueTable.id, glueId))).toEqual([]);
  });

  it("refuses a card whose text yields a single segment, leaving it alone", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "One indivisible thought" });

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result).toEqual({ ok: false, reason: "indivisible" });
    expect(await getCard({ db, partitionId, cardId })).toBeDefined();
  });

  it("refuses a card that belongs to another namespace", async () => {
    const { db, namespaceId } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherId, name: "Base", isDefault: true });
    const otherPartition = await addPartition({ db, namespaceId: otherId, name: "X" });
    const foreign = await addCard({ db, partitionId: otherPartition, content: "One. Two" });

    const result = await squashNamespaceCard({ db, namespaceId, cardId: foreign, ...CANVAS });

    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(await getCard({ db, partitionId: otherPartition, cardId: foreign })).toBeDefined();
  });

  it("creates a set too large for one insert statement", async () => {
    const { db, namespaceId, partitionId, scopeId } = await setup();
    const cardId = await addCard({
      db,
      partitionId,
      content: Array.from({ length: 250 }, (_, i) => `Piece ${i}`).join(". "),
    });
    await addScopeRel({ db, scopeId, cardId });

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result.ok && result.cards).toHaveLength(250);
    expect(await getAllCards({ db, partitionId })).toHaveLength(250);
    // The scope memberships are batched the same way the cards are.
    expect(await getAllCardsByScope({ db, scopeId })).toHaveLength(250);
  });

  it("refuses a card that would split into more cards than one request may carry", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({
      db,
      partitionId,
      content: Array.from({ length: BATCH_MAX + 1 }, (_, i) => `Piece ${i}`).join(". "),
    });

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result).toEqual({ ok: false, reason: "too-many" });
    expect(await getCard({ db, partitionId, cardId })).toBeDefined();
  });

  it("keeps the pieces on the board when the card sits against its edge", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({
      db,
      partitionId,
      content: "One. Two. Three",
      posX: CANVAS.canvasWidth - 10,
      posY: CANVAS.canvasHeight,
    });

    const result = await squashNamespaceCard({ db, namespaceId, cardId, ...CANVAS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const { posX, posY } of result.cards) {
      expect(posX).toBeLessThanOrEqual(CANVAS.canvasWidth);
      expect(posY).toBeLessThanOrEqual(CANVAS.canvasHeight);
    }
  });
});
