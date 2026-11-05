import type {
  KozaneBackend,
  CardCreateInput,
  CardUpdateInput,
  InventoryTakeInput,
} from "../lib/backend/index.js";

/** Compiled consumer fixture. Never invoked or included in a runtime entry point. */
export function checkBackendInputs(backend: KozaneBackend): void {
  const card: CardCreateInput = {
    partitionId: "p",
    content: "Text",
    posX: 1,
    scopeId: "s",
    layerId: "l",
    inventoryId: "i",
  };
  void backend.cards.create("n", card, { keepalive: true });
  const widthReset: CardUpdateInput = { width: null };
  void backend.cards.update("n", "c", widthReset);
  void backend.cards.update("n", "c", { content: "Text", posX: 1 });
  void backend.cards.updatePositions("n", { positions: [{ cardId: "c", posX: 1, posY: 2 }] });
  void backend.cards.remove("n", { cardIds: ["c"] as const });
  void backend.cards.move("n", { cardIds: ["c"], targetNamespaceId: "other" });
  void backend.cards.setLayer("n", { cardIds: ["c"], layerId: "l" });
  void backend.cards.setPartition("n", { cardIds: ["c"], partitionId: "p" });
  void backend.cards.setStacking("n", { cardIds: ["c"], direction: "front" });
  void backend.cards.squash("n", { cardId: "c" });
  void backend.glues.create("n", { cardIds: ["c", "d"] as const });
  void backend.glues.remove("n", { cardIds: ["c"] });
  void backend.layers.create("n", { name: "Layer" });
  void backend.layers.rename("n", "l", { name: "Layer" });
  void backend.layers.reorder("n", { layerIds: ["l", "other"] as const });
  void backend.partitions.create("n", { name: "Partition" });
  void backend.partitions.rename("n", "p", { name: "Partition" });
  void backend.scopes.create("n", { name: "Scope" });
  void backend.scopes.rename("n", "s", { name: "Scope" });
  void backend.scopes.addMembers("n", "s", { cardIds: ["c"] });
  void backend.scopes.removeMembers("n", "s", { cardIds: ["c"] });
  void backend.scopes.createArea("n", "s", { posX: 1, posY: 2, width: 10, height: 20 });
  void backend.scopes.updateArea("n", "s", "a", { posX: 1, posY: 2, width: 10, height: 20 });
  void backend.warps.create("n", { posX: 1, posY: 2 });
  void backend.warps.update("n", "w", { posX: 1, posY: 2 });
  void backend.inventories.create("n", { posX: 1, posY: 2 });
  void backend.inventories.update("n", "i", { name: "Tray" });
  void backend.inventories.update("n", "i", { posX: 1, posY: 2, name: "Tray" });
  void backend.inventories.stow("n", "i", { cardIds: ["c"], slot: 0 });
  const take: InventoryTakeInput = { cards: [{ cardId: "c" }, { cardId: "d", posX: 1, posY: 2 }] };
  void backend.inventories.take("n", take);
  void backend.namespaces.create({ name: "Namespace" });

  // @ts-expect-error Card creation requires a partition.
  void backend.cards.create("n", { content: "Text" });
  // @ts-expect-error Card content is text.
  void backend.cards.create("n", { partitionId: "p", content: 1 });
  // @ts-expect-error Null does not mean an omitted layer reference.
  void backend.cards.create("n", { partitionId: "p", content: "x", layerId: null });
  // @ts-expect-error A card update requires at least one field.
  void backend.cards.update("n", "c", {});
  // @ts-expect-error Only width supports null as a reset value.
  void backend.cards.update("n", "c", { content: null });
  // @ts-expect-error Stacking accepts only front or back.
  void backend.cards.setStacking("n", { cardIds: ["c"], direction: "up" });
  // @ts-expect-error Inventories require a complete position pair.
  void backend.inventories.update("n", "i", { posX: 1 });
  // @ts-expect-error No fields is not an inventory update.
  void backend.inventories.update("n", "i", {});
  // @ts-expect-error Omit a slot for automatic placement; null is invalid.
  void backend.inventories.stow("n", "i", { cardIds: ["c"], slot: null });
  // @ts-expect-error Take positions must also be paired.
  void backend.inventories.take("n", { cards: [{ cardId: "c", posX: 1 }] });
}
