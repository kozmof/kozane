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

/**
 * The four shapes a held reference is pruned in when a snapshot arrives, written once.
 *
 * `refreshFromData` below applies a snapshot over a board someone is working on, and every
 * reference the page holds into that data — the focused warp, the selection, the primary
 * card, the composer’s card, the active partition, the active scope — has to be checked
 * against what actually arrived. A card deleted by the CLI or another tab must not stay
 * selected, and a warp that is gone must not stay focused, or the remove shortcut aims at a
 * row that is no longer there.
 *
 * Each of those was spelled out longhand, and the reasons differ while the mechanics do
 * not: six copies of `if (ref && !rows.some(({ id }) => id === ref)) ref = null`, two of
 * them with the comparison inlined into a multi-line `if` and one written as a `filter`
 * over a `Set`. The cost is not the repetition, it is that adding a seventh thing the page
 * can hold a reference to means remembering to add a seventh step here, with nothing to say
 * so and nothing that fails if it is forgotten.
 *
 * So the mechanics move here and the reasons stay at the call sites, where they belong.
 * Exported because they are the part worth testing directly — a prune is a pure function of
 * a reference and a set, and reaching it through a mounted board was the only way before.
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
 * A held row, replaced by the snapshot’s copy of it, or dropped when it is gone.
 *
 * The composer holds a card rather than an id, so pruning it and refreshing it are the same
 * lookup: a card still present must be swapped for the arriving version — the text may have
 * changed under it — and one that is absent must be let go. Written as two branches over the
 * same `find`, which is what made it the one prune here that could disagree with itself.
 */
export function prunedRow<T extends { id: string }>(held: T | null, rows: readonly T[]): T | null {
  return held === null ? null : (rows.find(({ id }) => id === held.id) ?? null);
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
    // A layer deleted by the CLI or another tab must not stay selected. Not a `prunedRef`:
    // this is the one held reference with somewhere to fall back to rather than nowhere, and
    // `resolveActiveLayerId` is what knows where.
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
    // A row rather than an id, so this both drops a card that is gone and picks up the text
    // of one that has been edited elsewhere; see {@link prunedRow}.
    this.selection.composerCard = prunedRow(this.selection.composerCard, data.cards);

    this.sidebar.activePartition = prunedRef(this.sidebar.activePartition, idSet(data.partitions));
    // A scope can leave this list without being deleted: `data.scopes` is narrowed to the
    // ones this namespace draws, so an unattached scope another namespace has since claimed
    // simply stops arriving. Either way it must not stay the active filter.
    this.sidebar.activeScope = prunedRef(this.sidebar.activeScope, idSet(data.scopes));
  }
}
