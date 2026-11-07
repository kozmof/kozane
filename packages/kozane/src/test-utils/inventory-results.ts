import type {
  InventoryCreateResult,
  InventoryRemoveResult,
  InventoryStowResult,
  InventoryTakeResult,
} from "../../../client/src/backend/index.js";
export const inventoryResults = {
  "inventories.create": {
    id: "i",
    namespaceId: "n /",
    name: "",
    posX: 1,
    posY: 2,
  } satisfies InventoryCreateResult,
  "inventories.update": {
    id: "i",
    namespaceId: "n /",
    name: "Tray",
    posX: 1,
    posY: 2,
  } satisfies InventoryCreateResult,
  "inventories.remove": { releasedCardIds: ["c"] } satisfies InventoryRemoveResult,
  "inventories.stow": {
    placements: [{ cardId: "c", inventoryId: "i", slot: 0 }],
    clearedCardIds: [],
  } satisfies InventoryStowResult,
  "inventories.take": { cards: [{ cardId: "c" }] } satisfies InventoryTakeResult,
};
