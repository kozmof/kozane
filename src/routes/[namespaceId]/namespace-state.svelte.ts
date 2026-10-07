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
} from "$lib/types";
import { TaskspaceTreeState } from "./lib/taskspace-tree.svelte.js";
import { InFlight } from "./lib/in-flight.js";

// Re-exported for the components and tests that already name it through this module.
export type { NamespaceDataSnapshot } from "$lib/types";

/** The layer new cards land on, falling back to the namespace's default layer. */
export function resolveActiveLayerId(layers: Layer[], preferredId: string | null): string | null {
  if (preferredId && layers.some(({ id }) => id === preferredId)) return preferredId;
  return layers.find(({ isDefault }) => isDefault)?.id ?? layers[0]?.id ?? null;
}

const ACTIVE_LAYER_STORAGE_PREFIX = "kozane:active-layer:";

/**
 * Remember each namespace's active layer in per-tab storage. Ignore unavailable or failing
 * storage so losing a preference does not block the board.
 */
export function readStoredLayerId(namespaceId: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(ACTIVE_LAYER_STORAGE_PREFIX + namespaceId) ?? null;
  } catch {
    return null;
  }
}

export function storeActiveLayerId(namespaceId: string, layerId: string | null): void {
  try {
    const key = ACTIVE_LAYER_STORAGE_PREFIX + namespaceId;
    if (layerId) globalThis.sessionStorage?.setItem(key, layerId);
    else globalThis.sessionStorage?.removeItem(key);
  } catch {
    // Ignored: see readStoredLayerId.
  }
}

/**
 * Prune held IDs, selections, and rows against incoming snapshot data so deleted entities
 * cannot remain active. Share the pure lookup mechanics while keeping each state's policy at
 * its call site.
 */

/** The ids a snapshot carries, as the set every prune below is asked against. */
export function idSet(rows: readonly { id: string }[]): Set<string> {
  return new Set(rows.map(({ id }) => id));
}

/** One held id, dropped when the snapshot no longer carries the row it names. */
export function prunedRef(ref: string | null, present: ReadonlySet<string>): string | null {
  return ref !== null && present.has(ref) ? ref : null;
}

/** A set of held ids, narrowed to the ones the snapshot still carries. */
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
  newScopeName = $state("");
  newWcName = $state("");

  reset() {
    this.activePartition = null;
    this.activeScope = null;
    this.newPartitionName = "";
    this.newScopeName = "";
    this.newWcName = "";
  }
}

export class NamespaceState {
  namespaceId = $state("");
  fetcher: typeof fetch = fetch;
  /**
   * Track outstanding mutations so polling waits for them and discards responses spanning a
   * mutation.
   */
  readonly mutations = new InFlight();

  mutationFetcher: typeof fetch = (input, init) =>
    this.mutations.track(() => this.fetcher(input, init));

  cards = $state<CardWithGlue[]>([]);
  partitions = $state<Partition[]>([]);
  layers = $state<Layer[]>([]);
  activeLayerId = $state<string | null>(null);
  warps = $state<Warp[]>([]);
  /** The warp last jumped to or clicked, which the remove shortcut acts on. */
  focusedWarpId = $state<string | null>(null);
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
    this.activeLayerId = resolveActiveLayerId(data.layers, readStoredLayerId(data.namespace.id));
    this.warps = data.warps;
    this.focusedWarpId = null;
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
    this.activeLayerId = resolveActiveLayerId(data.layers, this.activeLayerId);
    this.warps = data.warps;
    this.scopes = data.scopes;
    this.scopeRels = data.scopeRels;
    this.scopeAreas = data.scopeAreas;
    this.glueRels = data.glueRels;
    this.taskspaces = data.taskspaces;
    // A taskspace deleted by the CLI or another tab must not leave its directory rows
    // cached behind the row that is gone.
    this.taskspaceTree.prune(data.taskspaces.map(({ id }) => id));

    // A warp deleted by another tab must not stay focused, or the remove shortcut would
    // aim at a row that is no longer there.
    this.focusedWarpId = prunedRef(this.focusedWarpId, idSet(data.warps));

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
