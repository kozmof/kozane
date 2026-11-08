import { createSessionPreferences, type PreferenceStorage } from "../preferences.js";
export { readStoredLayerId, storeActiveLayerId } from "../preferences.js";
import type {
  CardWithGlue,
  Partition,
  Layer,
  NamespaceDataSnapshot,
  Scope,
  ScopeRel,
  ScopeArea,
  GlueRel,
  TaskspaceSummary,
  Warp,
  Inventory,
} from "@kozane/core";
import { TaskspaceTreeState } from "./lib/taskspace-tree.svelte.js";
import { InFlight } from "./lib/in-flight.js";

// Re-exported for the components and tests that already name it through this module.
export type { NamespaceDataSnapshot } from "@kozane/core";

/** The layer new cards land on, falling back to the namespace's default layer. */
export function resolveActiveLayerId(layers: Layer[], preferredId: string | null): string | null {
  if (preferredId && layers.some(({ id }) => id === preferredId)) return preferredId;
  return layers.find(({ isDefault }) => isDefault)?.id ?? layers[0]?.id ?? null;
}

/**
 * Prune held IDs, selections, and rows against incoming snapshot data so deleted entities
 * cannot remain active. Share the pure lookup mechanics while keeping each state's policy at
 * its call site.
 */

/** Snapshot IDs used to remove stale references. */
export function idSet(rows: readonly { id: string }[]): Set<string> {
  return new Set(rows.map(({ id }) => id));
}

/** Retain an ID only while its row remains in the snapshot. */
export function prunedRef(ref: string | null, present: ReadonlySet<string>): string | null {
  return ref !== null && present.has(ref) ? ref : null;
}

/** Retain only IDs present in the snapshot. */
export function prunedRefs(refs: ReadonlySet<string>, present: ReadonlySet<string>): Set<string> {
  return new Set([...refs].filter((id) => present.has(id)));
}

/**
 * Replace a held row with its snapshot version, or drop it if absent. This also refreshes the
 * composer's card text after external edits.
 */
export function prunedRow<T extends { id: string }>(held: T | null, rows: readonly T[]): T | null {
  return held === null ? null : (rows.find(({ id }) => id === held.id) ?? null);
}

export class SelectionState {
  selectedCards = $state(new Set<string>());
  primarySelectedId = $state<string | null>(null);
  composerCard = $state<CardWithGlue | null>(null);
  /** The single card whose resize handle is enabled by the resize shortcut. */
  resizingCardId = $state<string | null>(null);

  reset() {
    this.selectedCards = new Set();
    this.primarySelectedId = null;
    this.composerCard = null;
    this.resizingCardId = null;
  }
}

export class SidebarState {
  activePartition = $state<string | null>(null);
  activeScope = $state<string | null>(null);
  newPartitionName = $state("");

  reset() {
    this.activePartition = null;
    this.activeScope = null;
    this.newPartitionName = "";
  }
}

export class NamespaceState {
  #preferenceGeneration: number | undefined;
  constructor(private readonly preferences: PreferenceStorage = createSessionPreferences()) {}

  /** Save only after this generation's layer selection has been applied. */
  rememberActiveLayer(): void {
    const namespaceId = this.namespaceId;
    const layerId = this.activeLayerId;
    if (this.#preferenceGeneration !== this.preferences.generation) return;
    this.preferences.writeActiveLayer(namespaceId, layerId);
  }

  namespaceId = $state("");
  /**
   * Track outstanding mutations so polling waits for them and discards responses spanning a
   * mutation.
   */
  readonly mutations = new InFlight();

  cards = $state<CardWithGlue[]>([]);
  partitions = $state<Partition[]>([]);
  layers = $state<Layer[]>([]);
  activeLayerId = $state<string | null>(null);
  warps = $state<Warp[]>([]);
  /** The warp last jumped to or clicked, which the remove shortcut acts on. */
  focusedWarpId = $state<string | null>(null);
  inventories = $state<Inventory[]>([]);
  /** Inventories whose grid is showing. Closing one hides the grid and leaves its cards. */
  openInventoryIds = $state(new Set<string>());

  /**
   * The inventory new cards go into while one is open. Opening adds to the end of
   * `openInventoryIds`, so this is the one opened most recently. Null puts cards on the canvas.
   */
  get receivingInventoryId(): string | null {
    return [...this.openInventoryIds].at(-1) ?? null;
  }
  scopes = $state<Scope[]>([]);
  scopeRels = $state<ScopeRel[]>([]);
  scopeAreas = $state<ScopeArea[]>([]);
  glueRels = $state<GlueRel[]>([]);
  taskspaces = $state<TaskspaceSummary[]>([]);

  selection = new SelectionState();
  sidebar = new SidebarState();
  taskspaceTree = new TaskspaceTreeState();

  lastError = $state<string | null>(null);

  setError(message: string) {
    this.lastError = message;
  }

  resetFromData(data: NamespaceDataSnapshot) {
    this.namespaceId = data.namespace.id;
    this.cards = data.cards;
    this.partitions = data.partitions;
    this.layers = data.layers;
    this.#preferenceGeneration = this.preferences.generation;
    this.activeLayerId = resolveActiveLayerId(
      data.layers,
      this.preferences.readActiveLayer(data.namespace.id),
    );
    this.warps = data.warps;
    this.focusedWarpId = null;
    this.inventories = data.inventories;
    this.openInventoryIds = new Set();
    this.scopes = data.scopes;
    this.scopeRels = data.scopeRels;
    this.scopeAreas = data.scopeAreas;
    this.glueRels = data.glueRels;
    this.taskspaces = data.taskspaces;
    this.selection.reset();
    this.sidebar.reset();
    this.taskspaceTree.reset();
    this.lastError = null;
  }

  refreshFromData(data: NamespaceDataSnapshot) {
    this.cards = data.cards;
    this.partitions = data.partitions;
    this.layers = data.layers;
    // Resolve a fallback if the selected layer is deleted elsewhere. Unlike `prunedRef`,
    // `resolveActiveLayerId` selects a replacement.
    const generation = this.preferences.generation;
    const preferred =
      generation === this.#preferenceGeneration
        ? this.activeLayerId
        : this.preferences.readActiveLayer(this.namespaceId);
    this.activeLayerId = resolveActiveLayerId(data.layers, preferred);
    this.#preferenceGeneration = generation;
    this.warps = data.warps;
    this.inventories = data.inventories;
    this.scopes = data.scopes;
    this.scopeRels = data.scopeRels;
    this.scopeAreas = data.scopeAreas;
    this.glueRels = data.glueRels;
    this.taskspaces = data.taskspaces;
    // Remove cached directory rows for taskspaces deleted by the CLI or another tab.
    this.taskspaceTree.prune(data.taskspaces.map(({ id }) => id));

    // A warp deleted by another tab must not stay focused, or the remove shortcut would
    // aim at a row that is no longer there.
    this.focusedWarpId = prunedRef(this.focusedWarpId, idSet(data.warps));
    // An inventory deleted elsewhere closes, rather than leaving an empty window behind.
    this.openInventoryIds = prunedRefs(this.openInventoryIds, idSet(data.inventories));

    const cardIds = idSet(data.cards);
    this.selection.selectedCards = prunedRefs(this.selection.selectedCards, cardIds);
    this.selection.primarySelectedId = prunedRef(this.selection.primarySelectedId, cardIds);
    // Refresh the held card row or clear it if deleted. See {@link prunedRow}.
    this.selection.composerCard = prunedRow(this.selection.composerCard, data.cards);

    this.sidebar.activePartition = prunedRef(this.sidebar.activePartition, idSet(data.partitions));
    // Clear the active filter if its scope leaves this namespace's snapshot, whether deleted
    // or claimed by another namespace.
    this.sidebar.activeScope = prunedRef(this.sidebar.activeScope, idSet(data.scopes));
  }
}
