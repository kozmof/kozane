import { applyPalette } from "@kozane/core";
import type { Inventory } from "@kozane/core";
import { cardMetrics, warpEntriesForNamespace, type WarpListEntry } from "../../warp-list.js";
import type { NamespaceState } from "../namespace-state.svelte.js";

/** The page data the board view reads. */
type BoardViewData = {
  namespace: { id: string; name: string };
  uiConfig: { defaultCardWidth: number; defaultFontSize: number };
};

/**
 * What the board draws, derived from the namespace state: partition colors, which cards are
 * on the canvas and shown, scope filters and frame labels, and the warp palette's rows.
 */
export class BoardView {
  readonly #s: NamespaceState;
  readonly #data: () => BoardViewData;
  readonly #directory: () => WarpListEntry[];

  /**
   * @param data Read on use, because namespace navigation replaces the page data.
   * @param directory Other namespaces' warps, listed after this one's.
   */
  constructor(s: NamespaceState, data: () => BoardViewData, directory: () => WarpListEntry[]) {
    this.#s = s;
    this.#data = data;
    this.#directory = directory;
  }

  readonly partitions = $derived.by(() => applyPalette(this.#s.partitions));
  readonly partitionColorById = $derived.by(() => new Map(this.partitions.map((b) => [b.id, b])));

  /** A stored card lives in its inventory's grid and is not drawn on the canvas. */
  readonly canvasCards = $derived.by(() => this.#s.cards.filter((c) => c.inventory === null));

  /** Canvas cards in the partition the sidebar filters by, or all of them. */
  readonly visibleCards = $derived.by(() => {
    const active = this.#s.sidebar.activePartition;
    return active ? this.canvasCards.filter((c) => c.partitionId === active) : this.canvasCards;
  });

  /** Members of the scope the sidebar filters by, or null when none is chosen. */
  readonly scopeCardIds = $derived.by(() => {
    const active = this.#s.sidebar.activeScope;
    if (!active) return null;
    return new Set(this.#s.scopeRels.filter((r) => r.scopeId === active).map((r) => r.cardId));
  });

  /** What each frame writes on its tab. Built from the scopes this board draws. */
  readonly scopeNameById = $derived.by(
    () => new Map(this.#s.scopes.map((scope) => [scope.id, scope.name])),
  );

  readonly defaultPartitionId = $derived.by(
    () => this.#s.sidebar.activePartition ?? this.partitions[0]?.id ?? "",
  );

  /** The open inventory the composer's new cards go into. See `receivingInventoryId`. */
  readonly receivingInventory = $derived.by(
    () => this.#s.inventories.find(({ id }) => id === this.#s.receivingInventoryId) ?? null,
  );

  /**
   * The warp palette's rows. This namespace's rows come from live state rather than the
   * server, so a warp just set with the warp key is in the palette before any request comes
   * back.
   */
  readonly warpEntries = $derived.by(() => {
    const data = this.#data();
    return [
      ...warpEntriesForNamespace({
        namespace: { id: data.namespace.id, name: data.namespace.name },
        warps: this.#s.warps,
        cards: this.canvasCards,
        metrics: cardMetrics(data.uiConfig),
        isCurrent: true,
      }),
      ...this.#directory(),
    ];
  });

  /** An inventory's name, or its number in creation order when it has none. */
  inventoryLabel = (inventory: Inventory): string => {
    if (inventory.name) return inventory.name;
    return `Inventory ${this.#s.inventories.findIndex(({ id }) => id === inventory.id) + 1}`;
  };
}
