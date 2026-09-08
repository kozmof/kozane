import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDB, seedCards } from "../../test-utils/db.js";
import { cardTable } from "../schema.js";
import type { DB } from "../tx.js";
import {
  INSERT_CHUNK_MAX,
  STATEMENT_PARAMS_MAX,
  WARP_HINT_MAX_CHARS,
} from "../../lib/constants.js";
import {
  addCard,
  addCards,
  defaultLayerIdForPartition,
  getCard,
  getAllCards,
  getCardsByPartitions,
  getCardMarkersByNamespaces,
  updateNamespaceCardPositions,
  updateCard,
  getCardPartitionNames,
  reassignCardsToPartition,
  reassignCardsToLayer,
  cardsInNamespace,
} from "./card.js";
import { addNamespace } from "./namespace.js";
import { addPartition } from "./partition.js";
import { NotFoundError } from "./utils.js";
import { addLayer } from "./layer.js";

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Test Namespace" });
  await addLayer({ db, namespaceId: namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General" });
  return { db, namespaceId, partitionId };
}

describe("addCards", () => {
  it("returns nothing for an empty list, without touching the database", async () => {
    const { db, partitionId } = await setup();
    const layerId = await defaultLayerIdForPartition({ db, partitionId });
    expect(await addCards({ db, partitionId, layerId, cards: [] })).toEqual([]);
    expect(await getAllCards({ db, partitionId })).toHaveLength(0);
  });

  it("stores each row's own content and position", async () => {
    const { db, partitionId } = await setup();
    const layerId = await defaultLayerIdForPartition({ db, partitionId });
    const ids = await addCards({
      db,
      partitionId,
      layerId,
      cards: [
        { content: "first", posX: 10, posY: 20 },
        { content: "second", posX: 30, posY: 40 },
      ],
    });
    expect(ids).toHaveLength(2);
    const first = await getCard({ db, partitionId, cardId: ids[0] });
    const second = await getCard({ db, partitionId, cardId: ids[1] });
    expect(first).toMatchObject({ content: "first", posX: 10, posY: 20, layerId });
    expect(second).toMatchObject({ content: "second", posX: 30, posY: 40, layerId });
  });

  // The ids come back in the order the rows were given, which is the order the text of a
  // squashed card reads — a caller filing them into a scope pairs them up by position.
  it("returns ids in the order the rows were given, across a chunk boundary", async () => {
    const { db, partitionId } = await setup();
    const layerId = await defaultLayerIdForPartition({ db, partitionId });
    const cards = Array.from({ length: INSERT_CHUNK_MAX + 25 }, (_, index) => ({
      content: `card ${index}`,
      posX: index,
      posY: 0,
    }));
    const ids = await addCards({ db, partitionId, layerId, cards });

    expect(ids).toHaveLength(cards.length);
    expect(new Set(ids).size).toBe(cards.length);
    const stored = await getAllCards({ db, partitionId });
    const byId = new Map(stored.map((card) => [card.id, card]));
    expect(ids.map((id) => byId.get(id)?.content)).toEqual(cards.map(({ content }) => content));
  });
});

describe("addCard", () => {
  it("returns a non-empty id", async () => {
    const { db, partitionId } = await setup();
    const id = await addCard({ db, partitionId, content: "Hello" });
    expect(id).toBeTruthy();
  });

  it("defaults position to (0, 0)", async () => {
    const { db, partitionId } = await setup();
    const id = await addCard({ db, partitionId, content: "Hello" });
    const card = await getCard({ db, partitionId, cardId: id });
    expect(card?.posX).toBe(0);
    expect(card?.posY).toBe(0);
  });

  it("stores specified position", async () => {
    const { db, partitionId } = await setup();
    const id = await addCard({ db, partitionId, content: "Hi", posX: 100, posY: 200 });
    const card = await getCard({ db, partitionId, cardId: id });
    expect(card?.posX).toBe(100);
    expect(card?.posY).toBe(200);
  });

  it("assigns unique ids", async () => {
    const { db, partitionId } = await setup();
    const id1 = await addCard({ db, partitionId, content: "A" });
    const id2 = await addCard({ db, partitionId, content: "B" });
    expect(id1).not.toBe(id2);
  });
});

describe("getCard", () => {
  it("returns the card when partitionId and cardId match", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    const card = await getCard({ db, partitionId, cardId });
    expect(card?.id).toBe(cardId);
    expect(card?.content).toBe("Hi");
    expect(card?.partitionId).toBe(partitionId);
  });

  it("returns undefined for a missing cardId", async () => {
    const { db, partitionId } = await setup();
    expect(await getCard({ db, partitionId, cardId: "ghost" })).toBeUndefined();
  });

  it("returns undefined when cardId belongs to a different partition", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const otherId = await addPartition({ db, namespaceId, name: "Other" });
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    expect(await getCard({ db, partitionId: otherId, cardId })).toBeUndefined();
  });
});

describe("getAllCards", () => {
  it("returns empty array for a partition with no cards", async () => {
    const { db, partitionId } = await setup();
    expect(await getAllCards({ db, partitionId })).toEqual([]);
  });

  it("returns all cards in the partition", async () => {
    const { db, partitionId } = await setup();
    const c1 = await addCard({ db, partitionId, content: "A" });
    const c2 = await addCard({ db, partitionId, content: "B" });
    const cards = await getAllCards({ db, partitionId });
    expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining([c1, c2]));
    expect(cards).toHaveLength(2);
  });
});

describe("getCardsByPartitions", () => {
  it("returns empty array for an empty partitionIds list", async () => {
    const { db } = await setup();
    expect(await getCardsByPartitions({ db, partitionIds: [] })).toEqual([]);
  });

  it("returns cards across multiple partitions", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const b2 = await addPartition({ db, namespaceId, name: "Second" });
    const c1 = await addCard({ db, partitionId, content: "In b1" });
    const c2 = await addCard({ db, partitionId: b2, content: "In b2" });
    const cards = await getCardsByPartitions({ db, partitionIds: [partitionId, b2] });
    expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining([c1, c2]));
    expect(cards).toHaveLength(2);
  });

  it("does not return cards from partitions not in the list", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const b2 = await addPartition({ db, namespaceId, name: "Second" });
    await addCard({ db, partitionId: b2, content: "Not included" });
    const cards = await getCardsByPartitions({ db, partitionIds: [partitionId] });
    expect(cards).toHaveLength(0);
  });
});

describe("getCardMarkersByNamespaces", () => {
  it("returns empty array for an empty namespaceIds list", async () => {
    const { db } = await setup();
    expect(await getCardMarkersByNamespaces({ db, namespaceIds: [] })).toEqual([]);
  });

  it("returns the position, stacking and content of every card in the named namespaces", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const b2 = await addPartition({ db, namespaceId, name: "Second" });
    await addCard({ db, partitionId, content: "In b1", posX: 24, posY: 48 });
    await addCard({ db, partitionId: b2, content: "In b2", posX: 96, posY: 96, zIndex: 3 });

    const markers = await getCardMarkersByNamespaces({ db, namespaceIds: [namespaceId] });

    // `width` is null for a card that has never been resized, which is most of them: it
    // follows `ui.defaultCardWidth` until someone pins one.
    expect(markers).toEqual(
      expect.arrayContaining([
        {
          namespaceId,
          posX: 24,
          posY: 48,
          zIndex: 0,
          content: "In b1",
          contentChars: 5,
          width: null,
        },
        {
          namespaceId,
          posX: 96,
          posY: 96,
          zIndex: 3,
          content: "In b2",
          contentChars: 5,
          width: null,
        },
      ]),
    );
    expect(markers).toHaveLength(2);
  });

  // The reason the column is read at all: a resized card is drawn in a box it set itself,
  // and that is the box `nearestCardHint` measures a warp against.
  it("carries the width of a card that has been resized", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Wide", posX: 24, posY: 48 });
    await updateCard({ db, cardId, partitionId, width: 420 });

    const markers = await getCardMarkersByNamespaces({ db, namespaceIds: [namespaceId] });

    expect(markers).toEqual([
      { namespaceId, posX: 24, posY: 48, zIndex: 0, content: "Wide", contentChars: 4, width: 420 },
    ]);
  });

  it("does not return cards from a namespace not in the list", async () => {
    const { db, partitionId } = await setup();
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "General",
    });
    await addCard({ db, partitionId, content: "Mine" });
    await addCard({ db, partitionId: otherPartitionId, content: "Theirs" });

    const markers = await getCardMarkersByNamespaces({ db, namespaceIds: [otherNamespaceId] });

    expect(markers).toMatchObject([{ namespaceId: otherNamespaceId, content: "Theirs" }]);
  });

  it("reads only the opening of a long card", async () => {
    const { db, namespaceId, partitionId } = await setup();
    // Every card of every namespace with a warp is read to place one palette row, and a hint
    // is a few dozen characters: the rest of a long card is not worth carrying.
    await addCard({ db, partitionId, content: "A".repeat(4000) });

    const [marker] = await getCardMarkersByNamespaces({ db, namespaceIds: [namespaceId] });

    expect(marker.content.length).toBeGreaterThan(WARP_HINT_MAX_CHARS);
    expect(marker.content.length).toBeLessThan(4000);
    expect(marker.content).toBe("A".repeat(marker.content.length));
  });

  it("says how long the whole card is, however little of it is read", async () => {
    const { db, namespaceId, partitionId } = await setup();
    // What the opening cannot say: how tall the card is drawn, which is what decides
    // whether a warp is sitting on it.
    await addCard({ db, partitionId, content: "A".repeat(4000) });

    const [marker] = await getCardMarkersByNamespaces({ db, namespaceIds: [namespaceId] });

    expect(marker.contentChars).toBe(4000);
  });

  it("counts characters rather than bytes", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await addCard({ db, partitionId, content: "日本語" });

    const [marker] = await getCardMarkersByNamespaces({ db, namespaceIds: [namespaceId] });

    expect(marker.contentChars).toBe(3);
  });
});

describe("updateCard (content)", () => {
  it("changes the content", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Old" });
    await updateCard({ db, cardId, partitionId, content: "New" });
    const card = await getCard({ db, partitionId, cardId });
    expect(card?.content).toBe("New");
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db, partitionId } = await setup();
    await expect(updateCard({ db, cardId: "ghost", partitionId, content: "X" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("updateCard (position)", () => {
  it("changes posX and posY", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    await updateCard({ db, cardId, partitionId, posX: 300, posY: 400 });
    const card = await getCard({ db, partitionId, cardId });
    expect(card?.posX).toBe(300);
    expect(card?.posY).toBe(400);
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db, partitionId } = await setup();
    await expect(
      updateCard({ db, cardId: "ghost", partitionId, posX: 0, posY: 0 }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("updateCard (width)", () => {
  it("starts a new card with no width of its own", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    const card = await getCard({ db, partitionId, cardId });
    // Null rather than a number: the card is drawn at `ui.defaultCardWidth` and keeps
    // following it, which is what an untouched card is supposed to do.
    expect(card?.width).toBeNull();
  });

  it("pins a width", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    await updateCard({ db, cardId, partitionId, width: 360 });
    const card = await getCard({ db, partitionId, cardId });
    expect(card?.width).toBe(360);
  });

  it("clears a width back to null", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    await updateCard({ db, cardId, partitionId, width: 360 });
    await updateCard({ db, cardId, partitionId, width: null });
    const card = await getCard({ db, partitionId, cardId });
    expect(card?.width).toBeNull();
  });

  it("leaves the width alone when it is not named", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    await updateCard({ db, cardId, partitionId, width: 360 });
    await updateCard({ db, cardId, partitionId, content: "There" });
    const card = await getCard({ db, partitionId, cardId });
    expect(card?.width).toBe(360);
  });
});

describe("updateCard", () => {
  it("updates only the provided fields", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Original", posX: 10, posY: 20 });
    await updateCard({ db, cardId, partitionId, content: "Updated" });
    const card = await getCard({ db, partitionId, cardId });
    expect(card?.content).toBe("Updated");
    expect(card?.posX).toBe(10);
    expect(card?.posY).toBe(20);
  });

  it("throws when no fields are provided", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Same" });
    await expect(updateCard({ db, cardId, partitionId })).rejects.toThrow("no fields to update");
  });

  it("can move card to a different partition", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const b2 = await addPartition({ db, namespaceId, name: "Other" });
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    await updateCard({ db, cardId, partitionId, newPartitionId: b2 });
    expect(await getCard({ db, partitionId: b2, cardId })).toBeDefined();
    expect(await getCard({ db, partitionId, cardId })).toBeUndefined();
  });

  it("can update position fields with content", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Original", posX: 1, posY: 2 });

    await updateCard({ db, cardId, partitionId, content: "Moved", posX: 30, posY: 40 });

    const card = await getCard({ db, partitionId, cardId });
    expect(card?.content).toBe("Moved");
    expect(card?.posX).toBe(30);
    expect(card?.posY).toBe(40);
  });

  it("throws NotFoundError for a missing card", async () => {
    const { db, partitionId } = await setup();
    await expect(updateCard({ db, cardId: "ghost", partitionId, content: "X" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("updateNamespaceCardPositions", () => {
  it("accepts an empty positions array", async () => {
    const { db, namespaceId } = await setup();
    await expect(updateNamespaceCardPositions({ db, namespaceId, positions: [] })).resolves.toEqual(
      {
        ok: true,
      },
    );
  });

  it("updates positions when all cards belong to the namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const c1 = await addCard({ db, partitionId, content: "A", posX: 0, posY: 0 });
    const c2 = await addCard({ db, partitionId, content: "B", posX: 0, posY: 0 });

    const ok = await updateNamespaceCardPositions({
      db,
      namespaceId,
      positions: [
        { cardId: c1, posX: 10, posY: 20 },
        { cardId: c2, posX: 30, posY: 40 },
      ],
    });

    expect(ok).toEqual({ ok: true });
    expect(await getCard({ db, partitionId, cardId: c1 })).toMatchObject({ posX: 10, posY: 20 });
    expect(await getCard({ db, partitionId, cardId: c2 })).toMatchObject({ posX: 30, posY: 40 });
  });

  it("names the cards when one does not belong to the namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const ownCard = await addCard({ db, partitionId, content: "Mine", posX: 0, posY: 0 });
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Other",
    });
    const foreignCard = await addCard({ db, partitionId: otherPartitionId, content: "Theirs" });

    const ok = await updateNamespaceCardPositions({
      db,
      namespaceId,
      positions: [
        { cardId: ownCard, posX: 5, posY: 5 },
        { cardId: foreignCard, posX: 9, posY: 9 },
      ],
    });

    expect(ok).toEqual({ ok: false, reason: "foreign-cards" });
    expect(await getCard({ db, partitionId, cardId: ownCard })).toMatchObject({ posX: 0, posY: 0 });
  });

  /**
   * A drag wide enough that one `CASE` statement could not carry it.
   *
   * The two CASEs and the WHERE bind five parameters per card, so a request at `BATCH_MAX`
   * builds a statement of ten thousand — under SQLite's own ceiling today, and under it only
   * because nobody has added a third column to the CASE. The batching is what makes that a
   * property of the code rather than of a comment: enough positions to need several
   * statements still land as one atomic write.
   */
  it("applies a drag too wide for one statement, in batches, atomically", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const layerId = await defaultLayerIdForPartition({ db, partitionId });
    // Comfortably past what one statement affords at five parameters per row.
    const count = STATEMENT_PARAMS_MAX;
    const cardIds = await seedCards(db, { partitionId, layerId, count, prefix: "drag" });

    const result = await updateNamespaceCardPositions({
      db,
      namespaceId,
      positions: cardIds.map((cardId, index) => ({ cardId, posX: index + 1, posY: index + 2 })),
    });

    expect(result).toEqual({ ok: true });
    const first = await getCard({ db, partitionId, cardId: cardIds[0] });
    const last = await getCard({ db, partitionId, cardId: cardIds[count - 1] });
    expect(first).toMatchObject({ posX: 1, posY: 2 });
    expect(last).toMatchObject({ posX: count, posY: count + 1 });
  });

  it("moves nothing when a foreign card sits in a drag spanning several batches", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const layerId = await defaultLayerIdForPartition({ db, partitionId });
    const cardIds = await seedCards(db, {
      partitionId,
      layerId,
      count: STATEMENT_PARAMS_MAX,
      prefix: "drag",
    });
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Other",
    });
    const foreignCard = await addCard({ db, partitionId: otherPartitionId, content: "Theirs" });

    const result = await updateNamespaceCardPositions({
      db,
      namespaceId,
      positions: [...cardIds, foreignCard].map((cardId, index) => ({
        cardId,
        posX: index + 1,
        posY: index + 2,
      })),
    });

    // Ownership is checked before the first batch runs, so no batch runs at all.
    expect(result).toEqual({ ok: false, reason: "foreign-cards" });
    expect(await getCard({ db, partitionId, cardId: cardIds[0] })).toMatchObject({
      posX: 0,
      posY: 0,
    });
  });

  it("applies the last entry when a cardId is repeated", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "A", posX: 0, posY: 0 });

    const ok = await updateNamespaceCardPositions({
      db,
      namespaceId,
      positions: [
        { cardId, posX: 10, posY: 20 },
        { cardId, posX: 30, posY: 40 },
      ],
    });

    expect(ok).toEqual({ ok: true });
    expect(await getCard({ db, partitionId, cardId })).toMatchObject({ posX: 30, posY: 40 });
  });
});

describe("getCardPartitionNames", () => {
  it("returns empty array for empty input", async () => {
    const { db } = await setup();
    expect(await getCardPartitionNames({ db, cardIds: [] })).toEqual([]);
  });

  it("returns cardId, partitionId, and partitionName for each card", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    const result = await getCardPartitionNames({ db, cardIds: [cardId] });
    expect(result).toEqual([{ cardId, partitionId, partitionName: "General" }]);
  });

  it("returns one row per card across different partitions", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const b2 = await addPartition({ db, namespaceId, name: "Research" });
    const c1 = await addCard({ db, partitionId, content: "A" });
    const c2 = await addCard({ db, partitionId: b2, content: "B" });
    const result = await getCardPartitionNames({ db, cardIds: [c1, c2] });
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.cardId === c1)?.partitionName).toBe("General");
    expect(result.find((r) => r.cardId === c2)?.partitionName).toBe("Research");
  });

  it("only returns rows for the requested card ids", async () => {
    const { db, partitionId } = await setup();
    const c1 = await addCard({ db, partitionId, content: "Included" });
    await addCard({ db, partitionId, content: "Excluded" });
    const result = await getCardPartitionNames({ db, cardIds: [c1] });
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe(c1);
  });
});

describe("cardsInNamespace", () => {
  it("returns empty array for empty cardIds", async () => {
    const { db, namespaceId } = await setup();
    expect(await cardsInNamespace({ db, namespaceId, cardIds: [] })).toEqual([]);
  });
});

describe("reassignCardsToPartition", () => {
  it("accepts an empty cardIds array", async () => {
    const { db, namespaceId, partitionId } = await setup();
    await expect(
      reassignCardsToPartition({ db, namespaceId, cardIds: [], partitionId }),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it("reassigns cards to the target partition", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const targetPartition = await addPartition({ db, namespaceId, name: "Target" });
    const c1 = await addCard({ db, partitionId, content: "A" });
    const c2 = await addCard({ db, partitionId, content: "B" });

    const ok = await reassignCardsToPartition({
      db,
      namespaceId,
      cardIds: [c1, c2],
      partitionId: targetPartition,
    });

    expect(ok).toEqual({ ok: true });
    expect(await getCard({ db, partitionId: targetPartition, cardId: c1 })).toBeDefined();
    expect(await getCard({ db, partitionId: targetPartition, cardId: c2 })).toBeDefined();
    expect(await getCard({ db, partitionId, cardId: c1 })).toBeUndefined();
  });

  it("names the cards when one does not belong to the namespace", async () => {
    const { db, namespaceId } = await setup();
    const targetPartition = await addPartition({ db, namespaceId, name: "Target" });
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Other",
    });
    const foreignCard = await addCard({ db, partitionId: otherPartitionId, content: "Theirs" });

    const ok = await reassignCardsToPartition({
      db,
      namespaceId,
      cardIds: [foreignCard],
      partitionId: targetPartition,
    });

    expect(ok).toEqual({ ok: false, reason: "foreign-cards" });
  });

  it("names the partition when the target does not belong to the namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const c1 = await addCard({ db, partitionId, content: "A" });
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const foreignPartition = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Foreign",
    });

    const ok = await reassignCardsToPartition({
      db,
      namespaceId,
      cardIds: [c1],
      partitionId: foreignPartition,
    });

    expect(ok).toEqual({ ok: false, reason: "foreign-partition" });
    expect(await getCard({ db, partitionId, cardId: c1 })).toBeDefined();
  });
});

describe("reassignCardsToLayer", () => {
  it("accepts an empty cardIds array without stacking anything", async () => {
    const { db, namespaceId } = await setup();
    const { id: layerId } = await addLayer({ db, namespaceId, name: "Draft" });
    await expect(reassignCardsToLayer({ db, namespaceId, cardIds: [], layerId })).resolves.toEqual({
      ok: true,
      stacking: [],
    });
  });

  it("moves cards onto the target layer", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const { id: layerId } = await addLayer({ db, namespaceId, name: "Draft" });
    const c1 = await addCard({ db, partitionId, content: "A" });
    const c2 = await addCard({ db, partitionId, content: "B" });

    const result = await reassignCardsToLayer({ db, namespaceId, cardIds: [c1, c2], layerId });
    expect(result.ok).toBe(true);

    expect(await getCard({ db, partitionId, cardId: c1 })).toMatchObject({ layerId });
    expect(await getCard({ db, partitionId, cardId: c2 })).toMatchObject({ layerId });
  });

  it("restacks arriving cards above the target layer's own, keeping their order", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const { id: layerId } = await addLayer({ db, namespaceId, name: "Draft" });
    // Already on Draft, and well above where the default layer's cards sit.
    await addCard({ db, partitionId, content: "Resident", layerId, zIndex: 40 });
    const lower = await addCard({ db, partitionId, content: "Lower", zIndex: 3 });
    const higher = await addCard({ db, partitionId, content: "Higher", zIndex: 9 });

    const result = await reassignCardsToLayer({
      db,
      namespaceId,
      cardIds: [higher, lower],
      layerId,
    });

    expect(result).toEqual({
      ok: true,
      stacking: [
        { cardId: lower, zIndex: 41 },
        { cardId: higher, zIndex: 42 },
      ],
    });
    expect(await getCard({ db, partitionId, cardId: lower })).toMatchObject({
      layerId,
      zIndex: 41,
    });
    expect(await getCard({ db, partitionId, cardId: higher })).toMatchObject({
      layerId,
      zIndex: 42,
    });
  });

  it("leaves cards already on the target layer where they are", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const { id: layerId } = await addLayer({ db, namespaceId, name: "Draft" });
    const resident = await addCard({ db, partitionId, content: "Resident", layerId, zIndex: 5 });

    await expect(
      reassignCardsToLayer({ db, namespaceId, cardIds: [resident], layerId }),
    ).resolves.toEqual({ ok: true, stacking: [] });
    expect(await getCard({ db, partitionId, cardId: resident })).toMatchObject({ zIndex: 5 });
  });

  it("refuses when a card does not belong to the namespace", async () => {
    const { db, namespaceId } = await setup();
    const { id: layerId } = await addLayer({ db, namespaceId, name: "Draft" });
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    await addLayer({ db, namespaceId: otherNamespaceId, name: "Base", isDefault: true });
    const otherPartitionId = await addPartition({
      db,
      namespaceId: otherNamespaceId,
      name: "Other",
    });
    const foreignCard = await addCard({ db, partitionId: otherPartitionId, content: "Theirs" });

    await expect(
      reassignCardsToLayer({ db, namespaceId, cardIds: [foreignCard], layerId }),
    ).resolves.toEqual({ ok: false, reason: "foreign-cards" });
  });

  it("refuses when the target layer belongs to another namespace", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const card = await addCard({ db, partitionId, content: "A" });
    const before = await getCard({ db, partitionId, cardId: card });
    const otherNamespaceId = await addNamespace({ db, name: "Other" });
    const { id: foreignLayer } = await addLayer({
      db,
      namespaceId: otherNamespaceId,
      name: "Theirs",
      isDefault: true,
    });

    await expect(
      reassignCardsToLayer({ db, namespaceId, cardIds: [card], layerId: foreignLayer }),
    ).resolves.toEqual({ ok: false, reason: "foreign-layer" });
    expect(await getCard({ db, partitionId, cardId: card })).toMatchObject({
      layerId: before!.layerId,
    });
  });
});

/**
 * The rule `kozane card list --sort` rests on: `updated_at` follows a card's text and
 * nothing else about it. The board sends a position PATCH per drag, so were arranging the
 * board to count as updating, the interval between the two timestamps would measure how
 * recently a card was tidied rather than how long it stood before being rewritten.
 *
 * Backdated rather than slept on: the columns are stored to the second, so a card added
 * and edited inside the same second has the same timestamp either way. Setting a known
 * past value is what makes "did this move" answerable at all.
 */
describe("card timestamps", () => {
  const LONG_AGO = new Date("2020-01-01T00:00:00Z");

  async function backdate(db: DB, cardId: string): Promise<void> {
    await db
      .update(cardTable)
      .set({ createdAt: LONG_AGO, updatedAt: LONG_AGO })
      .where(eq(cardTable.id, cardId));
  }

  it("stamps a new card as created and updated together", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    const card = await getCard({ db, partitionId, cardId });
    expect(card?.createdAt).toBeInstanceOf(Date);
    expect(card?.updatedAt.getTime()).toBe(card?.createdAt.getTime());
  });

  /**
   * One moment for the whole call, not one reading of the clock per column per row.
   * A batch big enough to be split into several statements takes real time to write, and
   * cards that arrived together must not be separable in the listing by a second's drift
   * they never had — the same rule `db import` follows for a whole dump.
   *
   * Sized past {@link INSERT_CHUNK_MAX} so more than one statement is involved, which is
   * where per-chunk stamps would begin to differ.
   */
  it("stamps every card of a batch insert with the same moment", async () => {
    const { db, partitionId } = await setup();
    const layerId = await defaultLayerIdForPartition({ db, partitionId });
    await addCards({
      db,
      partitionId,
      layerId,
      cards: Array.from({ length: INSERT_CHUNK_MAX + 5 }, (_unused, index) => ({
        content: `card ${index}`,
        posX: 0,
        posY: 0,
      })),
    });
    const rows = await db
      .select({ createdAt: cardTable.createdAt, updatedAt: cardTable.updatedAt })
      .from(cardTable);
    expect(rows).toHaveLength(INSERT_CHUNK_MAX + 5);
    for (const row of rows) expect(row.updatedAt.getTime()).toBe(row.createdAt.getTime());
    expect(new Set(rows.map(({ createdAt }) => createdAt.getTime())).size).toBe(1);
  });

  it("moves updatedAt when the content changes, and leaves createdAt where it was", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Old" });
    await backdate(db, cardId);

    await updateCard({ db, cardId, partitionId, content: "New" });

    const card = await getCard({ db, partitionId, cardId });
    expect(card?.createdAt.getTime()).toBe(LONG_AGO.getTime());
    expect(card?.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("leaves updatedAt alone when the content sent is what the card already held", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Unchanged" });
    await backdate(db, cardId);

    // What the board's composer sends when a card is opened and saved without an edit: the
    // field is present, so `updateCard` writes it, and the row is left exactly as it was.
    await updateCard({ db, cardId, partitionId, content: "Unchanged" });

    const card = await getCard({ db, partitionId, cardId });
    expect(card?.content).toBe("Unchanged");
    expect(card?.updatedAt.getTime()).toBe(LONG_AGO.getTime());
  });

  it("moves updatedAt when a re-save changes the content back to something new", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "First" });
    await backdate(db, cardId);

    await updateCard({ db, cardId, partitionId, content: "First" });
    await updateCard({ db, cardId, partitionId, content: "Second" });

    const card = await getCard({ db, partitionId, cardId });
    expect(card?.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it("leaves updatedAt alone for a card that was only moved, resized, or restacked", async () => {
    const { db, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    await backdate(db, cardId);

    await updateCard({ db, cardId, partitionId, posX: 300, posY: 400 });
    await updateCard({ db, cardId, partitionId, width: 360 });
    await updateCard({ db, cardId, partitionId, zIndex: 7 });

    const card = await getCard({ db, partitionId, cardId });
    expect(card?.posX).toBe(300);
    expect(card?.updatedAt.getTime()).toBe(LONG_AGO.getTime());
  });

  it("leaves updatedAt alone for a card dragged through updateNamespaceCardPositions", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    await backdate(db, cardId);

    await updateNamespaceCardPositions({
      db,
      namespaceId,
      positions: [{ cardId, posX: 120, posY: 240 }],
    });

    const card = await getCard({ db, partitionId, cardId });
    expect(card?.posX).toBe(120);
    expect(card?.updatedAt.getTime()).toBe(LONG_AGO.getTime());
  });

  it("leaves updatedAt alone for a card moved to another partition or layer", async () => {
    const { db, namespaceId, partitionId } = await setup();
    const cardId = await addCard({ db, partitionId, content: "Hi" });
    await backdate(db, cardId);
    const otherPartitionId = await addPartition({ db, namespaceId, name: "Other" });
    const { id: otherLayerId } = await addLayer({ db, namespaceId, name: "Draft" });

    await reassignCardsToLayer({ db, namespaceId, cardIds: [cardId], layerId: otherLayerId });
    await reassignCardsToPartition({
      db,
      namespaceId,
      cardIds: [cardId],
      partitionId: otherPartitionId,
    });

    const card = await getCard({ db, partitionId: otherPartitionId, cardId });
    expect(card?.layerId).toBe(otherLayerId);
    expect(card?.updatedAt.getTime()).toBe(LONG_AGO.getTime());
  });
});
