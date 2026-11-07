import { expect, it } from "vitest";
import { INVENTORY_SLOT_MAX } from "../../constants/index.js";
import { inventoryResults } from "../../../../kozane/src/test-utils/inventory-results.js";
import {
  readInventoryResult,
  readInventoryRemoved,
  readInventoryStowed,
  readInventoryTaken,
} from "./inventories.js";
const take = { cards: [{ cardId: "c" }] };
it("preserves blank inventory names and binds returned rows to their destination", () => {
  const row = inventoryResults["inventories.create"];
  expect(readInventoryResult(row, "n /")).toEqual(row);
  expect(readInventoryResult(row, "n /", "i")).toEqual(row);
  expect(readInventoryResult(row, "other")).toBeNull();
  expect(readInventoryResult(row, "n /", "other")).toBeNull();
  expect(readInventoryResult({ ...row, posX: NaN }, "n /")).toBeNull();
});
it("validates unique released IDs and placements while permitting repaired neighbours", () => {
  expect(readInventoryRemoved({ releasedCardIds: [] })).toEqual({ releasedCardIds: [] });
  expect(readInventoryRemoved({ releasedCardIds: ["c", "c"] })).toBeNull();
  expect(readInventoryRemoved({})).toBeNull();
  const stow = inventoryResults["inventories.stow"];
  expect(readInventoryStowed(stow, "i")).toEqual(stow);
  const repaired = {
    placements: [...stow.placements, { cardId: "neighbour", inventoryId: "i", slot: 6 }],
    clearedCardIds: ["c", "neighbour"],
  };
  expect(readInventoryStowed(repaired, "i")).toEqual(repaired);
  for (const placements of [
    [{}],
    [{ cardId: "c", inventoryId: "other", slot: 0 }],
    [...stow.placements, stow.placements[0]],
    [...stow.placements, { cardId: "other", inventoryId: "i", slot: 0 }],
    ...[-1, 0.5, INVENTORY_SLOT_MAX + 1, Infinity].map((slot) => [
      { cardId: "c", inventoryId: "i", slot },
    ]),
  ])
    expect(readInventoryStowed({ ...stow, placements }, "i")).toBeNull();
  expect(readInventoryStowed({ ...stow, clearedCardIds: ["c", "c"] }, "i")).toBeNull();
  expect(readInventoryStowed({ placements: [], clearedCardIds: [] }, "i")).toEqual({
    placements: [],
    clearedCardIds: [],
  });
});
it("requires exactly the taken cards and paired finite positions when supplied", () => {
  expect(readInventoryTaken(inventoryResults["inventories.take"], take)).toEqual({
    cards: [{ cardId: "c" }],
  });
  const positioned = { cards: [{ cardId: "c", posX: 1, posY: 2 }] };
  expect(readInventoryTaken(positioned, positioned)).toEqual(positioned);
  for (const value of [
    {},
    { cards: [] },
    { cards: [{ cardId: "other" }] },
    { cards: [{ cardId: "c" }, { cardId: "c" }] },
    { cards: [{ cardId: "c", posX: 1 }] },
    { cards: [{ cardId: "c", posX: null, posY: null }] },
    { cards: [{ cardId: "c", posX: 1, posY: Infinity }] },
  ])
    expect(readInventoryTaken(value, take)).toBeNull();
  expect(readInventoryTaken(take, positioned)).toBeNull();
  expect(readInventoryTaken(take, {})).toBeNull();
  expect(readInventoryTaken(take, { cards: [{}] })).toBeNull();
  expect(readInventoryTaken(take, { cards: [{ cardId: "c" }, { cardId: "c" }] })).toBeNull();
  expect(
    readInventoryTaken(
      { cards: [{ cardId: "c" }, { cardId: "c" }] },
      { cards: [{ cardId: "c" }, { cardId: "d" }] },
    ),
  ).toBeNull();
});
it("accepts real service results across stow, take, repositioning and inventory removal", async () => {
  const { createTestDB } = await import("../../../../kozane/src/test-utils/db.js");
  const { createServiceContext } = await import("../../../../kozane/src/services/context.js");
  const namespaces = await import("../../../../kozane/src/services/namespaces.js");
  const inventories = await import("../../../../kozane/src/services/inventories.js");
  const cards = await import("../../../../kozane/src/services/cards.js");
  const { get } = await import("../../../../kozane/src/services/snapshot.js");
  const db = await createTestDB();
  const context = createServiceContext({ canvasWidth: 400, canvasHeight: 400 });
  const namespace = await namespaces.create(db, context, { name: "Board" });
  const partitionId = (await get(db, context, namespace.id))!.snapshot.partitions[0].id;
  const card = await cards.create(db, context, namespace.id, {
    content: "Card",
    partitionId,
    posX: 10,
    posY: 20,
  });
  const inventory = await inventories.create(db, context, namespace.id, { posX: -10, posY: 900 });
  expect(readInventoryResult(inventory, namespace.id)).toEqual(inventory);
  expect(inventory).toMatchObject({ name: "", posX: 0, posY: 400 });
  const moved = await inventories.update(db, context, namespace.id, inventory.id, {
    name: " Tray ",
    posX: 20.6,
    posY: -10,
  });
  expect(readInventoryResult(moved, namespace.id, inventory.id)).toEqual(moved);
  expect(moved).toMatchObject({ name: "Tray", posX: 21, posY: 0 });
  const request = { cardIds: [card.id] };
  const stowed = await inventories.stow(db, context, namespace.id, inventory.id, request);
  expect(readInventoryStowed(stowed, inventory.id)).toEqual(stowed);
  const noOp = await inventories.stow(db, context, namespace.id, inventory.id, request);
  expect(readInventoryStowed(noOp, inventory.id)).toEqual({ placements: [], clearedCardIds: [] });
  const unchanged = { cards: [{ cardId: card.id }] };
  expect(
    readInventoryTaken(await inventories.take(db, context, namespace.id, unchanged), unchanged),
  ).toEqual(unchanged);
  expect((await get(db, context, namespace.id))!.snapshot.cards[0]).toMatchObject({
    posX: 10,
    posY: 20,
    inventory: null,
  });
  await inventories.stow(db, context, namespace.id, inventory.id, request);
  const drop = { cards: [{ cardId: card.id, posX: 900, posY: -10 }] };
  expect(readInventoryTaken(await inventories.take(db, context, namespace.id, drop), drop)).toEqual(
    { cards: [{ cardId: card.id, posX: 400, posY: 0 }] },
  );
  await inventories.stow(db, context, namespace.id, inventory.id, request);
  const removed = await inventories.remove(db, context, namespace.id, inventory.id);
  expect(readInventoryRemoved(removed)).toEqual({ releasedCardIds: [card.id] });
  expect((await get(db, context, namespace.id))!.snapshot.cards[0].inventory).toBeNull();
});
