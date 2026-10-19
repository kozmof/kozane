import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addInventory, getAllInventories, stowCards } from "$db/api/inventory.js";
import { addNamespace } from "$db/api/namespace.js";
import { addLayer } from "$db/api/layer.js";
import { addPartition } from "$db/api/partition.js";
import { addCard } from "$db/api/card.js";
import { cardTable } from "$db/schema.js";
import type { DB } from "$db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { CANVAS_W } from "../../../../lib/constants.js";
import { POST as create } from "./+server.js";
import { PATCH as update, DELETE as remove } from "./[inventoryId]/+server.js";
import { POST as stow } from "./[inventoryId]/cards/+server.js";
import { POST as take } from "./take/+server.js";

function event(db: DB, params: Record<string, string>, body?: unknown) {
  const request =
    body === undefined
      ? undefined
      : new Request("http://localhost/api", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
  return { locals: { db }, params, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message?: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({
    status,
    ...(message && { body: { message } }),
  });
}

async function setup() {
  const db = await createTestDB();
  const namespaceId = await addNamespace({ db, name: "Namespace" });
  await addLayer({ db, namespaceId, name: "Base", isDefault: true });
  const partitionId = await addPartition({ db, namespaceId, name: "General", isDefault: true });
  const inventory = await addInventory({ db, namespaceId, posX: 0, posY: 0 });
  const card = (posX = 0, posY = 0) => addCard({ db, partitionId, content: "c", posX, posY });
  return { db, namespaceId, inventory, card };
}

async function row(db: DB, cardId: string) {
  return db
    .select({
      inventoryId: cardTable.inventoryId,
      inventorySlot: cardTable.inventorySlot,
      posX: cardTable.posX,
      posY: cardTable.posY,
    })
    .from(cardTable)
    .where(eq(cardTable.id, cardId))
    .get();
}

describe("POST /[namespaceId]/api/inventories", () => {
  it("stores a clamped, named inventory and returns the row", async () => {
    const { db, namespaceId } = await setup();

    const response = await create(
      event(db, { namespaceId }, { posX: CANVAS_W + 50, posY: 10.6, name: "  Tools  " }),
    );

    expect(await response.json()).toMatchObject({
      namespaceId,
      name: "Tools",
      posX: CANVAS_W,
      posY: 11,
    });
  });

  it("requires a position and a known namespace", async () => {
    const { db, namespaceId } = await setup();

    await expectHttpRejection(
      create(event(db, { namespaceId }, { posX: 1 })),
      400,
      "posX and posY are required",
    );
    await expectHttpRejection(
      create(event(db, { namespaceId: "missing" }, { posX: 0, posY: 0 })),
      404,
    );
  });
});

describe("PATCH and DELETE /[namespaceId]/api/inventories/[inventoryId]", () => {
  it("moves and renames", async () => {
    const { db, namespaceId, inventory } = await setup();
    const params = { namespaceId, inventoryId: inventory.id };

    const response = await update(event(db, params, { posX: 100, posY: 200, name: "Later" }));

    expect(await response.json()).toMatchObject({ posX: 100, posY: 200, name: "Later" });
  });

  it("refuses half a position, an empty body, and another namespace's inventory", async () => {
    const { db, namespaceId, inventory } = await setup();
    const params = { namespaceId, inventoryId: inventory.id };
    const otherId = await addNamespace({ db, name: "Other" });

    await expectHttpRejection(update(event(db, params, { posX: 1 })), 400);
    await expectHttpRejection(update(event(db, params, {})), 400);
    await expectHttpRejection(
      update(event(db, { namespaceId: otherId, inventoryId: inventory.id }, { name: "x" })),
      404,
    );
  });

  it("deletes, handing back the cards it returned to the canvas", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card(40, 80);
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [a], slot: null });

    const response = await remove(event(db, { namespaceId, inventoryId: inventory.id }));

    expect(await response.json()).toEqual({ releasedCardIds: [a] });
    expect(await getAllInventories({ db, namespaceId })).toEqual([]);
    expect(await row(db, a)).toEqual({
      inventoryId: null,
      inventorySlot: null,
      posX: 40,
      posY: 80,
    });
  });
});

describe("POST /[namespaceId]/api/inventories/[inventoryId]/cards", () => {
  it("stores cards and reports their slots", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card();
    const params = { namespaceId, inventoryId: inventory.id };

    const response = await stow(event(db, params, { cardIds: [a], slot: 3 }));

    expect(await response.json()).toEqual({
      placements: [{ cardId: a, inventoryId: inventory.id, slot: 3 }],
      clearedCardIds: [a],
    });
  });

  it("refuses a bad slot, a foreign card, and a foreign inventory", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card();
    const params = { namespaceId, inventoryId: inventory.id };
    const other = await setup();

    await expectHttpRejection(stow(event(db, params, { cardIds: [a], slot: -1 })), 400);
    await expectHttpRejection(stow(event(db, params, { cardIds: [a], slot: 1.5 })), 400);
    await expectHttpRejection(
      stow(event(db, params, { cardIds: ["missing"] })),
      400,
      "Some cards do not belong to this namespace",
    );
    await expectHttpRejection(
      stow(event(db, { namespaceId, inventoryId: other.inventory.id }, { cardIds: [a] })),
      400,
      "Inventory not found in namespace",
    );
  });
});

describe("POST /[namespaceId]/api/inventories/take", () => {
  it("returns cards to a given position or to where they were", async () => {
    const { db, namespaceId, inventory, card } = await setup();
    const a = await card(10, 20);
    const b = await card(30, 40);
    await stowCards({ db, namespaceId, inventoryId: inventory.id, cardIds: [a, b], slot: null });

    const response = await take(
      event(db, { namespaceId }, { cards: [{ cardId: a, posX: 500.4, posY: -5 }, { cardId: b }] }),
    );

    expect(await response.json()).toEqual({
      cards: [{ cardId: a, posX: 500, posY: 0 }, { cardId: b }],
    });
    expect(await row(db, a)).toEqual({
      inventoryId: null,
      inventorySlot: null,
      posX: 500,
      posY: 0,
    });
    expect(await row(db, b)).toEqual({
      inventoryId: null,
      inventorySlot: null,
      posX: 30,
      posY: 40,
    });
  });

  it("refuses half a position, a repeated card, and a foreign card", async () => {
    const { db, namespaceId, card } = await setup();
    const a = await card();

    await expectHttpRejection(
      take(event(db, { namespaceId }, { cards: [{ cardId: a, posX: 1 }] })),
      400,
    );
    await expectHttpRejection(
      take(event(db, { namespaceId }, { cards: [{ cardId: a }, { cardId: a }] })),
      400,
    );
    await expectHttpRejection(take(event(db, { namespaceId }, { cards: [{ cardId: "x" }] })), 400);
  });
});
