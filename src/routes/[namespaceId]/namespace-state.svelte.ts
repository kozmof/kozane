import type {
  CardWithGlue,
  Partition,
  Layer,
  NamespaceDataSnapshot,
  Scope,
  ScopeRel,
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
 * Which layer this namespace was last worked on, kept per tab. A reload that dropped the
 * selection back to `Base` would undo the one thing the layer control is for. Storage is
 * absent while prerendering and can throw when a browser has it disabled, so every access
 * is treated as best-effort — a lost preference is not worth an error banner.
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

export class SelectionState {
  selectedCards = $state(new Set<string>());
  primarySelectedId = $state<string | null>(null);
  composerCard = $state<CardWithGlue | null>(null);
  /**
   * The card showing its resize handle, armed by the resize shortcut. Only ever one: the
   * handle is somewhere to put the pointer, and two on the board at once would leave
   * nothing saying which card the next drag is about to resize.
   */
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
   * The mutations this board has outstanding. The snapshot poll stands down while any is
   * open and drops an answer that arrived across one — see `snapshot-poll.ts`, which is
   * handed this alongside the page's own drag activity.
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
    // A layer deleted by the CLI or another tab must not stay selected.
    this.activeLayerId = resolveActiveLayerId(data.layers, this.activeLayerId);
    this.warps = data.warps;
    // A warp deleted by another tab must not stay focused, or the remove shortcut would
    // aim at a row that is no longer there.
    if (this.focusedWarpId && !data.warps.some(({ id }) => id === this.focusedWarpId)) {
      this.focusedWarpId = null;
    }
    this.scopes = data.scopes;
    this.scopeRels = data.scopeRels;
    this.glueRels = data.glueRels;
    this.taskspaces = data.taskspaces;
    // A taskspace deleted by the CLI or another tab must not leave its directory rows
    // cached behind the row that is gone.
    this.taskspaceTree.prune(data.taskspaces.map(({ id }) => id));

    const cardIds = new Set(data.cards.map(({ id }) => id));
    this.selection.selectedCards = new Set(
      [...this.selection.selectedCards].filter((id) => cardIds.has(id)),
    );
    if (this.selection.primarySelectedId && !cardIds.has(this.selection.primarySelectedId)) {
      this.selection.primarySelectedId = null;
    }
    if (this.selection.composerCard && !cardIds.has(this.selection.composerCard.id)) {
      this.selection.composerCard = null;
    } else if (this.selection.composerCard) {
      this.selection.composerCard =
        data.cards.find(({ id }) => id === this.selection.composerCard?.id) ?? null;
    }

    if (
      this.sidebar.activePartition &&
      !data.partitions.some(({ id }) => id === this.sidebar.activePartition)
    ) {
      this.sidebar.activePartition = null;
    }
    // A scope can leave this list without being deleted: `data.scopes` is narrowed to the
    // ones this namespace draws, so an unattached scope another namespace has since claimed
    // simply stops arriving. Either way it must not stay the active filter.
    if (
      this.sidebar.activeScope &&
      !data.scopes.some(({ id }) => id === this.sidebar.activeScope)
    ) {
      this.sidebar.activeScope = null;
    }
  }
}
