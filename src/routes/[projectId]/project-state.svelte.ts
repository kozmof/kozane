import type {
  CardWithGlue,
  Bundle,
  Layer,
  Scope,
  ScopeRel,
  GlueRel,
  TaskspaceSummary,
} from "$lib/types";

/** The layer new cards land on, falling back to the project's default layer. */
export function resolveActiveLayerId(layers: Layer[], preferredId: string | null): string | null {
  if (preferredId && layers.some(({ id }) => id === preferredId)) return preferredId;
  return layers.find(({ isDefault }) => isDefault)?.id ?? layers[0]?.id ?? null;
}

const ACTIVE_LAYER_STORAGE_PREFIX = "kozane:active-layer:";

/**
 * Which layer this project was last worked on, kept per tab. A reload that dropped the
 * selection back to `Base` would undo the one thing the layer control is for. Storage is
 * absent while prerendering and can throw when a browser has it disabled, so every access
 * is treated as best-effort — a lost preference is not worth an error banner.
 */
export function readStoredLayerId(projectId: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(ACTIVE_LAYER_STORAGE_PREFIX + projectId) ?? null;
  } catch {
    return null;
  }
}

export function storeActiveLayerId(projectId: string, layerId: string | null): void {
  try {
    const key = ACTIVE_LAYER_STORAGE_PREFIX + projectId;
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

  reset() {
    this.selectedCards = new Set();
    this.primarySelectedId = null;
    this.composerCard = null;
  }
}

export class SidebarState {
  activeBundle = $state<string | null>(null);
  activeScope = $state<string | null>(null);
  newBundleName = $state("");
  newScopeName = $state("");
  newWcName = $state("");

  reset() {
    this.activeBundle = null;
    this.activeScope = null;
    this.newBundleName = "";
    this.newScopeName = "";
    this.newWcName = "";
  }
}

export interface ProjectDataSnapshot {
  project: { id: string };
  cards: CardWithGlue[];
  bundles: Bundle[];
  layers: Layer[];
  scopes: Scope[];
  scopeRels: ScopeRel[];
  glueRels: GlueRel[];
  taskspaces: TaskspaceSummary[];
}

export class ProjectState {
  projectId = $state("");
  fetcher: typeof fetch = fetch;
  pendingMutations = $state(0);
  mutationVersion = $state(0);

  mutationFetcher: typeof fetch = async (input, init) => {
    this.pendingMutations += 1;
    this.mutationVersion += 1;
    try {
      return await this.fetcher(input, init);
    } finally {
      this.pendingMutations = Math.max(0, this.pendingMutations - 1);
      this.mutationVersion += 1;
    }
  };

  cards = $state<CardWithGlue[]>([]);
  bundles = $state<Bundle[]>([]);
  layers = $state<Layer[]>([]);
  activeLayerId = $state<string | null>(null);
  scopes = $state<Scope[]>([]);
  scopeRels = $state<ScopeRel[]>([]);
  glueRels = $state<GlueRel[]>([]);
  taskspaces = $state<TaskspaceSummary[]>([]);

  selection = new SelectionState();
  sidebar = new SidebarState();

  lastError = $state<string | null>(null);

  setError(message: string) {
    this.lastError = message;
  }

  resetFromData(data: ProjectDataSnapshot) {
    this.projectId = data.project.id;
    this.cards = data.cards;
    this.bundles = data.bundles;
    this.layers = data.layers;
    this.activeLayerId = resolveActiveLayerId(data.layers, readStoredLayerId(data.project.id));
    this.scopes = data.scopes;
    this.scopeRels = data.scopeRels;
    this.glueRels = data.glueRels;
    this.taskspaces = data.taskspaces;
    this.selection.reset();
    this.sidebar.reset();
    this.lastError = null;
  }

  refreshFromData(data: ProjectDataSnapshot) {
    this.cards = data.cards;
    this.bundles = data.bundles;
    this.layers = data.layers;
    // A layer deleted by the CLI or another tab must not stay selected.
    this.activeLayerId = resolveActiveLayerId(data.layers, this.activeLayerId);
    this.scopes = data.scopes;
    this.scopeRels = data.scopeRels;
    this.glueRels = data.glueRels;
    this.taskspaces = data.taskspaces;

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
      this.sidebar.activeBundle &&
      !data.bundles.some(({ id }) => id === this.sidebar.activeBundle)
    ) {
      this.sidebar.activeBundle = null;
    }
    if (
      this.sidebar.activeScope &&
      !data.scopes.some(({ id }) => id === this.sidebar.activeScope)
    ) {
      this.sidebar.activeScope = null;
    }
  }
}
