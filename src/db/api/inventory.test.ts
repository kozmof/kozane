import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import { cardTable } from "../schema.js";
import {
  addInventory,
  deleteInventory,
  findInventoryConflicts,
  getAllInventories,
  getInventoryCards,
  refitStoredCardInTx,
  repairInventories,
  stowCards,
  takeCards,
  updateInventory,
} from "./inventory.js";
import { addCard } from "./card.js";
import { addNamespace, deleteNamespace } from "./namespace.js";
import { addPartition } from "./partition.js";
import { addLayer } from "./layer.js";
import { getGlueRelsByNamespace, glueNamespaceCards } from "./glue.js";
import { moveCardsToNamespace } from "./composite.js";
import { updateCard } from "./card.js";
import { cardSpan } from "../../lib/inventory.js";
import { withTx } from "../tx.js";
import { NotFoundError } from "./utils.js";
import { INVENTORY_COLUMNS, INVENTORY_SLOT_MAX } from "../../lib/constants.js";
import type { DB } from "../tx.js";

/** A namespace with the default layer and a partition, which is what a card needs. */
async function addBoard(db: DB, name: string) {
  const namespaceId = await addNamespace({ db, name });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  return { namespaceId, partitionId };
}

async function setup() {
  const db = await createTestDB();
  const { namespaceId, partitionId } = await addBoard(db, "Test Namespace");
  const inventory = await addInventory({ db, namespaceId, posX: 100, posY: 200 });
  const card = (content: string, posX = 0, posY = 0) =>
    addCard({ db, partitionId, content, posX, posY });
  return { db, namespaceId, inventory, card };
}

async function placement(db: DB, cardId: string) {
  const row = await db
    .select({
      inventoryId: cardTable.inventoryId,
      inventorySlot: cardTable.inventorySlot,
      posX: cardTable.posX,
      posY: cardTable.posY,
    })
    .from(cardTable)
    .where(eq(cardTable.id, cardId))
    .get();
  return row!;
}

describe("addInventory", () => {
  it("returns the stored row, unnamed unless a name is given", async () => {
    const { db, namespaceId } = await setup();

    const unnamed = await addInventory({ db, namespaceId, posX: 10, posY: 20 });
    const named = await addInventory({ db, namespaceId, name: "Tools", posX: 0, posY: 0 });

    expect(unnamed).toMatchObject({ namespaceId, name: "", posX: 10, posY: 20 });
    expect(named.name).toBe("Tools");
  });

  it("lists a namespace's inventories oldest first, and no one else's", async () => {
    const { db, namespaceId, inventory } = await setup();
    const second = await addInventory({ db, namespaceId, posX: 0, posY: 0 });
    const otherId = await addNamespace({ db, name: "Other" });
    await addInventory({ db, namespaceId: otherId, posX: 0, posY: 0 });

    expect((await getAllInventories({ db, namespaceId })).map(({ id }) => id)).toEqual([
      inventory.id,
      second.id,
    ]);
  });
});

describe("updateInventory", () => {
  it("moves and renames, returning the stored row", async () => {
    const { db, namespaceId, inventory } = await setup();

    const moved = await updateInventory({
      db,
      namespaceId,
      inventoryId: inventory.id,
      position: { posX: 300, posY: 400 },
    });
    const renamed = await updateInventory({
      db,
      namespaceId,
      inventoryId: inventory.id,
      name: "Later",
    });

    expect(moved).toMatchObject({ posX: 300, posY: 400, name: "" });
    expect(renamed).toMatchObject({ posX: 300, posY: 400, name: "Later" });
  });

  it("refuses an inventory of another namespace", async () => {
    const { db, inventory } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });

    await expect(
      updateInventory({ db, namespaceId: otherId, inventoryId: inventory.id, name: "x" }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("stowCards", () => {
  it("fills the first free slots and keeps each card's canvas position", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card("a", 48, 96);
    const b = await card("b");

    const result = await stowCards({
      db,
      namespaceId,
      inventoryId: inventory.id,
      cardIds: [a, b],
      slot: null,
    });

    expect(result).toMatchObject({
      ok: true,
      placements: [
        { cardId: a, slot: 0, inventoryId: inventory.id },
        { cardId: b, slot: 1, inventoryId: inventory.id },
      ],
    });
    expect(await placement(db, a)).toEqual({
      inventoryId: inventory.id,
      inventorySlot: 0,
      posX: 48,
      posY: 96,
    });
    expect(await getInventoryCards({ db, inventoryId: inventory.id })).toEqual([
      { id: a, content: "a", slot: 0 },
      { id: b, content: "b", slot: 1 },
    ]);
  });

  it("swaps two cards within one inventory without tripping the slot index", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card("a");
    const b = await card("b");
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [a, b], slot: null });

    const result = await stowCards({
      db,
      namespaceId,
      inventoryId: inventory.id,
      cardIds: [b],
      slot: 0,
    });

    expect(result.ok).toBe(true);
    expect((await placement(db, a)).inventorySlot).toBe(1);
    expect((await placement(db, b)).inventorySlot).toBe(0);
  });

  it("moves a card between inventories", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const other = await addInventory({ db, namespaceId, posX: 0, posY: 0 });
    const a = await card("a");
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [a], slot: null });

    await stowCards({ db, namespaceId, inventoryId: other.id, cardIds: [a], slot: 3 });

    expect(await placement(db, a)).toMatchObject({ inventoryId: other.id, inventorySlot: 3 });
    expect(await getInventoryCards({ db, inventoryId: inventory.id })).toEqual([]);
  });

  it("takes stored cards out of their glue groups", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card("a");
    const b = await card("b");
    await glueNamespaceCards({ db, namespaceId, cardIds: [a, b] });

    const result = await stowCards({
      db,
      namespaceId,
      inventoryId: inventory.id,
      cardIds: [a],
      slot: null,
    });

    // The pair dissolves, so the card left on the canvas is cleared too.
    expect(result.ok && [...result.clearedCardIds].sort()).toEqual([a, b].sort());
    expect(await getGlueRelsByNamespace({ db, namespaceId })).toEqual([]);
  });

  it("refuses an inventory of another namespace, and cards of another namespace", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const { namespaceId: otherId, partitionId: otherPartitionId } = await addBoard(db, "Other");
    const foreign = await addCard({ db, partitionId: otherPartitionId, content: "x" });
    const a = await card("a");

    expect(
      await stowCards({
        db,
        namespaceId: otherId,
        inventoryId: inventory.id,
        cardIds: [foreign],
        slot: null,
      }),
    ).toEqual({ ok: false, reason: "foreign-inventory" });
    expect(
      await stowCards({
        db,
        namespaceId,
        inventoryId: inventory.id,
        cardIds: [a, foreign],
        slot: null,
      }),
    ).toEqual({ ok: false, reason: "foreign-cards" });
    expect((await placement(db, a)).inventoryId).toBeNull();
  });

  it("refuses a plan past the last slot", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card("a");
    const b = await card("b");

    expect(
      await stowCards({
        db,
        namespaceId,
        inventoryId: inventory.id,
        cardIds: [a, b],
        slot: INVENTORY_SLOT_MAX,
      }),
    ).toEqual({ ok: false, reason: "inventory-full" });
  });
});

describe("tall cards", () => {
  const long = "word ".repeat(40).trim();

  it("places the next card beside a tall one rather than in the cells it covers", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    expect(cardSpan(long)).toBeGreaterThan(1);
    const tall = await card(long);
    const short = await card("short");

    const result = await stowCards({
      db,
      namespaceId,
      inventoryId: inventory.id,
      cardIds: [tall, short],
      slot: null,
    });

    expect(result.ok && result.placements.map(({ slot }) => slot)).toEqual([0, 1]);
  });

  it("refuses a tall card whose lowest cell would pass the last slot", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const tall = await card(long);

    expect(
      await stowCards({
        db,
        namespaceId,
        inventoryId: inventory.id,
        cardIds: [tall],
        slot: INVENTORY_SLOT_MAX,
      }),
    ).toEqual({ ok: false, reason: "inventory-full" });
  });

  it("moves a stored card whose longer text now covers its neighbour", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const grows = await card("short");
    const below = await card("below");
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [grows], slot: 0 });
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [below], slot: 6 });
    const partitionId = (await db.select().from(cardTable).where(eq(cardTable.id, grows)).get())!
      .partitionId;

    const refit = await withTx(db, async (tx) => {
      await updateCard({ db: tx, cardId: grows, partitionId, content: long });
      return refitStoredCardInTx({ db: tx, cardId: grows });
    });

    const moved = { cardId: grows, inventoryId: inventory.id, slot: 1 };
    expect(refit).toEqual({ moved, placements: [moved] });
    expect((await placement(db, grows)).inventorySlot).toBe(1);
    expect((await placement(db, below)).inventorySlot).toBe(6);
  });

  it("leaves a stored card that still fits, and a card on the canvas, alone", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const stored = await card("short");
    const loose = await card("loose");
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [stored], slot: 0 });

    const unmoved = { moved: null, placements: [] };
    expect(await withTx(db, (tx) => refitStoredCardInTx({ db: tx, cardId: stored }))).toEqual(
      unmoved,
    );
    expect(await withTx(db, (tx) => refitStoredCardInTx({ db: tx, cardId: loose }))).toEqual(
      unmoved,
    );
  });
});

describe("takeCards", () => {
  it("puts a card at the given position, or back where it was", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card("a", 10, 20);
    const b = await card("b", 30, 40);
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [a, b], slot: null });

    const result = await takeCards({
      db,
      namespaceId,
      cards: [{ cardId: a, position: { posX: 500, posY: 600 } }, { cardId: b }],
    });

    expect(result).toEqual({ ok: true });
    expect(await placement(db, a)).toEqual({
      inventoryId: null,
      inventorySlot: null,
      posX: 500,
      posY: 600,
    });
    expect(await placement(db, b)).toEqual({
      inventoryId: null,
      inventorySlot: null,
      posX: 30,
      posY: 40,
    });
  });

  it("refuses cards of another namespace", async () => {
    const { db, card } = await setup();
    const a = await card("a");
    const otherId = await addNamespace({ db, name: "Other" });

    expect(await takeCards({ db, namespaceId: otherId, cards: [{ cardId: a }] })).toEqual({
      ok: false,
      reason: "foreign-cards",
    });
  });

  it("refuses a card already on the canvas, and moves nothing", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const stored = await card("stored", 10, 20);
    const loose = await card("loose", 30, 40);
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [stored], slot: 0 });

    const result = await takeCards({
      db,
      namespaceId,
      cards: [{ cardId: stored }, { cardId: loose, position: { posX: 500, posY: 600 } }],
    });

    expect(result).toEqual({ ok: false, reason: "unstored-cards" });
    expect(await placement(db, stored)).toMatchObject({ inventoryId: inventory.id });
    expect(await placement(db, loose)).toMatchObject({ posX: 30, posY: 40 });
  });
});

describe("glueNamespaceCards", () => {
  it("refuses a stored card, so a stored card is never in a group", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card("a");
    const b = await card("b");
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [a], slot: 0 });

    expect(await glueNamespaceCards({ db, namespaceId, cardIds: [a, b] })).toEqual({
      ok: false,
      reason: "stored-cards",
    });
    expect(await getGlueRelsByNamespace({ db, namespaceId })).toEqual([]);
  });
});

describe("findInventoryConflicts", () => {
  it("finds nothing in inventories writers filled", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const cardIds = [await card("a"), await card("word ".repeat(40)), await card("c")];
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds, slot: null });

    expect(await findInventoryConflicts({ db })).toEqual({ overlapping: [], glued: [] });
  });

  it("names cards that overlap and stored cards left in a group", async () => {
    const { db, tall, below, glued } = await brokenInventory();

    const conflicts = await findInventoryConflicts({ db });
    expect(conflicts.overlapping.toSorted()).toEqual([tall, below].toSorted());
    expect(conflicts.glued).toEqual([glued]);
  });
});

/**
 * Create conflicts that an import or layout change can leave behind. A tall card at slot 0
 * overlaps `below`, and a stored card remains glued to a card on the canvas.
 */
async function brokenInventory() {
  const board = await setup();
  const { db, namespaceId, inventory, card } = board;
  const tall = await card("word ".repeat(40));
  const below = await card("below");
  const glued = await card("glued");
  const partner = await card("partner");
  await glueNamespaceCards({ db, namespaceId, cardIds: [glued, partner] });
  const storeAt = (cardId: string, slot: number) =>
    db
      .update(cardTable)
      .set({ inventoryId: inventory.id, inventorySlot: slot })
      .where(eq(cardTable.id, cardId));
  await storeAt(tall, 0);
  await storeAt(below, INVENTORY_COLUMNS);
  await storeAt(glued, 1);
  return { ...board, tall, below, glued, partner };
}

describe("repairInventories", () => {
  it("moves overlapping cards apart and ungroups stored cards, leaving nothing to find", async () => {
    const { db, inventory, tall, below, glued } = await brokenInventory();

    const repair = await repairInventories({ db });

    expect(repair.moved).toEqual([
      { cardId: below, inventoryId: inventory.id, slot: INVENTORY_COLUMNS + 1 },
    ]);
    expect(repair.unglued).toEqual([glued]);
    expect((await placement(db, tall)).inventorySlot).toBe(0);
    expect(await findInventoryConflicts({ db })).toEqual({ overlapping: [], glued: [] });
    expect(await repairInventories({ db })).toEqual({ moved: [], unglued: [] });
  });
});

describe("a write to an overlapping inventory", () => {
  it("repairs it first, and the stow answers with the repaired card too", async () => {
    const { db, namespaceId, inventory, card, below } = await brokenInventory();
    const added = await card("added");

    const result = await stowCards({
      db,
      namespaceId,
      inventoryId: inventory.id,
      cardIds: [added],
      slot: null,
    });

    expect(result.ok && result.placements).toContainEqual({
      cardId: below,
      inventoryId: inventory.id,
      slot: INVENTORY_COLUMNS + 1,
    });
    expect((await findInventoryConflicts({ db })).overlapping).toEqual([]);
  });

  it("writes no repair when it refuses the stow", async () => {
    const { db, namespaceId, inventory, card, below } = await brokenInventory();
    const a = await card("a");
    const b = await card("b");

    expect(
      await stowCards({
        db,
        namespaceId,
        inventoryId: inventory.id,
        cardIds: [a, b],
        slot: INVENTORY_SLOT_MAX,
      }),
    ).toEqual({ ok: false, reason: "inventory-full" });
    expect((await placement(db, below)).inventorySlot).toBe(INVENTORY_COLUMNS);
  });

  it("refits an edited card when the repair moves a neighbour onto its slot", async () => {
    const { db, inventory, card, below } = await brokenInventory();
    // Where the repair moves `below`, so the edited card must make way rather than fail
    // the edit on the unique index.
    const edited = await card("c");
    await db
      .update(cardTable)
      .set({ inventoryId: inventory.id, inventorySlot: INVENTORY_COLUMNS + 1 })
      .where(eq(cardTable.id, edited));
    const { partitionId } = (await db
      .select({ partitionId: cardTable.partitionId })
      .from(cardTable)
      .where(eq(cardTable.id, edited))
      .get())!;

    const refit = await withTx(db, async (tx) => {
      await updateCard({ db: tx, cardId: edited, partitionId, content: "cc" });
      return refitStoredCardInTx({ db: tx, cardId: edited });
    });

    expect((await placement(db, below)).inventorySlot).toBe(INVENTORY_COLUMNS + 1);
    expect(refit.moved).not.toBeNull();
    expect((await placement(db, edited)).inventorySlot).toBe(refit.moved!.slot);
    // The neighbour the repair moved is reported too, so the board can draw it there.
    expect(refit.placements).toContainEqual({
      cardId: below,
      inventoryId: inventory.id,
      slot: INVENTORY_COLUMNS + 1,
    });
    expect((await findInventoryConflicts({ db })).overlapping).toEqual([]);
  });
});

describe("deleteInventory", () => {
  it("returns its cards to the canvas where they were before they were stored", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card("a", 72, 144);
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [a], slot: 2 });

    expect(await deleteInventory({ db, namespaceId, inventoryId: inventory.id })).toEqual({
      releasedCardIds: [a],
    });

    expect(await placement(db, a)).toEqual({
      inventoryId: null,
      inventorySlot: null,
      posX: 72,
      posY: 144,
    });
    expect(await getAllInventories({ db, namespaceId })).toEqual([]);
  });

  it("refuses an inventory of another namespace", async () => {
    const { db, inventory } = await setup();
    const otherId = await addNamespace({ db, name: "Other" });

    await expect(
      deleteInventory({ db, namespaceId: otherId, inventoryId: inventory.id }),
    ).rejects.toThrow(NotFoundError);
  });

  it("goes with its namespace, stored cards and all", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card("a");
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [a], slot: null });

    await deleteNamespace({ db, namespaceId });

    expect(await getAllInventories({ db, namespaceId })).toEqual([]);
  });
});

describe("moveCardsToNamespace", () => {
  it("takes a stored card out of the inventory it leaves behind", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card("a", 24, 48);
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [a], slot: null });
    const { namespaceId: targetId } = await addBoard(db, "Target");

    await moveCardsToNamespace({
      db,
      sourceNamespaceId: namespaceId,
      targetNamespaceId: targetId,
      cardIds: [a],
    });

    expect(await placement(db, a)).toEqual({
      inventoryId: null,
      inventorySlot: null,
      posX: 24,
      posY: 48,
    });
  });
});
