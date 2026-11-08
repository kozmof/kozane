import type {
  KozaneClient,
  CardCreateInput,
  CardUpdateInput,
  InventoryTakeInput,
  TaskspaceSaveFileInput,
  TaskspaceReadFileResult,
  SnapshotResult,
  TagsResult,
  MapResult,
  WarpDirectoryResult,
} from "../../../client/src/client/index.js";

/** Compiled consumer fixture. Never invoked or included in a runtime entry point. */
export function checkClientInputs(client: KozaneClient): void {
  void client.subscribe(() => {});
  void client.subscribeState((state) => {
    if (state.status === "ready") {
      const refreshError: import("../../../client/src/client/index.js").ClientError | undefined =
        state.refreshError;
      void refreshError?.retryAfterMs;
    }
  });
  const card: CardCreateInput = {
    partitionId: "p",
    content: "Text",
    posX: 1,
    scopeId: "s",
    layerId: "l",
    inventoryId: "i",
  };
  void client.cards.create("n", card, { keepalive: true });
  const widthReset: CardUpdateInput = { width: null };
  void client.cards.update("n", "c", widthReset);
  void client.cards.update("n", "c", { content: "Text", posX: 1 });
  void client.cards.updatePositions("n", { positions: [{ cardId: "c", posX: 1, posY: 2 }] });
  void client.cards.remove("n", { cardIds: ["c"] as const });
  void client.cards.move("n", { cardIds: ["c"], targetNamespaceId: "other" });
  void client.cards.setLayer("n", { cardIds: ["c"], layerId: "l" });
  void client.cards.setPartition("n", { cardIds: ["c"], partitionId: "p" });
  void client.cards.setStacking("n", { cardIds: ["c"], direction: "front" });
  void client.cards.squash("n", { cardId: "c" });
  void client.glues.create("n", { cardIds: ["c", "d"] as const });
  void client.glues.remove("n", { cardIds: ["c"] });
  void client.layers.create("n", { name: "Layer" });
  void client.layers.rename("n", "l", { name: "Layer" });
  void client.layers.reorder("n", { layerIds: ["l", "other"] as const });
  void client.partitions.create("n", { name: "Partition" });
  void client.partitions.rename("n", "p", { name: "Partition" });
  void client.scopes.create("n", { name: "Scope" });
  void client.scopes.rename("n", "s", { name: "Scope" });
  void client.scopes.addMembers("n", "s", { cardIds: ["c"] });
  void client.scopes.removeMembers("n", "s", { cardIds: ["c"] });
  void client.scopes.createArea("n", "s", { posX: 1, posY: 2, width: 10, height: 20 });
  void client.scopes.updateArea("n", "s", "a", { posX: 1, posY: 2, width: 10, height: 20 });
  void client.warps.create("n", { posX: 1, posY: 2 });
  void client.warps.update("n", "w", { posX: 1, posY: 2 });
  void client.inventories.create("n", { posX: 1, posY: 2 });
  void client.inventories.update("n", "i", { name: "Tray" });
  void client.inventories.update("n", "i", { posX: 1, posY: 2, name: "Tray" });
  void client.inventories.stow("n", "i", { cardIds: ["c"], slot: 0 });
  const take: InventoryTakeInput = { cards: [{ cardId: "c" }, { cardId: "d", posX: 1, posY: 2 }] };
  void client.inventories.take("n", take);
  void client.namespaces.create({ name: "Namespace" });

  const snapshot: Promise<SnapshotResult> = client.snapshot("n", { validator: "opaque" });
  const tags: Promise<TagsResult> = client.tags.get();
  const map: Promise<MapResult> = client.map.get();
  const directory: Promise<WarpDirectoryResult> = client.warpDirectory.get("n");
  void [snapshot, tags, map, directory];
  void client.namespaces.list();
  void client.namespaces.get("n");
  void client.tags.get("n");
  void client.cards.removeOne("n", "c");
  void client.layers.remove("n", "l");
  void client.partitions.remove("n", "p");
  void client.scopes.remove("n", "s");
  void client.scopes.removeArea("n", "s", "a");
  void client.warps.remove("n", "w");
  void client.inventories.remove("n", "i");
  if (client.taskspaces) {
    const files = client.taskspaces;
    void files.access("n", { id: "t", path: "notes" });
    void files.create("n", { name: "Notes", scopeId: "s" });
    void files.rename("n", "t", { name: "Notes" });
    void files.remove("n", "t");
    void files.createFile("n", "t", { path: "notes.md" });
    const read: Promise<TaskspaceReadFileResult> = files.readFile("n", "t", "notes.md", {
      signal: new AbortController().signal,
    });
    void read;
    const save: TaskspaceSaveFileInput = { path: "notes.md", content: "Text", signature: null };
    void files.saveFile("n", "t", save, { keepalive: true });
    void files.list("n", "t", "");
    void files.createDirectory("n", "t", { path: "folder" });
    void files.renameEntry("n", "t", { path: "notes.md", name: "renamed.md" });
    void files.removeEntry("n", "t", "notes.md");
    // @ts-expect-error Save requires an explicit last-read signature.
    void files.saveFile("n", "t", { path: "notes.md", content: "Text" });
    // @ts-expect-error Taskspace creation requires a scope.
    void files.create("n", { name: "Notes" });
  }

  // @ts-expect-error Card creation requires a partition.
  void client.cards.create("n", { content: "Text" });
  // @ts-expect-error Card content is text.
  void client.cards.create("n", { partitionId: "p", content: 1 });
  // @ts-expect-error Null does not mean an omitted layer reference.
  void client.cards.create("n", { partitionId: "p", content: "x", layerId: null });
  // @ts-expect-error A card update requires at least one field.
  void client.cards.update("n", "c", {});
  // @ts-expect-error Only width supports null as a reset value.
  void client.cards.update("n", "c", { content: null });
  // @ts-expect-error Stacking accepts only front or back.
  void client.cards.setStacking("n", { cardIds: ["c"], direction: "up" });
  // @ts-expect-error Inventories require a complete position pair.
  void client.inventories.update("n", "i", { posX: 1 });
  // @ts-expect-error No fields is not an inventory update.
  void client.inventories.update("n", "i", {});
  // @ts-expect-error Omit a slot for automatic placement; null is invalid.
  void client.inventories.stow("n", "i", { cardIds: ["c"], slot: null });
  // @ts-expect-error Take positions must also be paired.
  void client.inventories.take("n", { cards: [{ cardId: "c", posX: 1 }] });
}
