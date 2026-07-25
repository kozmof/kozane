import type {
  CardWithGlue,
  Bundle,
  Scope,
  ScopeRel,
  GlueRel,
  WorkingCopySummary,
} from "$lib/types";

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
  scopes: Scope[];
  scopeRels: ScopeRel[];
  glueRels: GlueRel[];
  workingCopies: WorkingCopySummary[];
}

export class ProjectState {
  projectId = $state("");
  fetcher: typeof fetch = fetch;

  cards = $state<CardWithGlue[]>([]);
  bundles = $state<Bundle[]>([]);
  scopes = $state<Scope[]>([]);
  scopeRels = $state<ScopeRel[]>([]);
  glueRels = $state<GlueRel[]>([]);
  workingCopies = $state<WorkingCopySummary[]>([]);

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
    this.scopes = data.scopes;
    this.scopeRels = data.scopeRels;
    this.glueRels = data.glueRels;
    this.workingCopies = data.workingCopies;
    this.selection.reset();
    this.sidebar.reset();
    this.lastError = null;
  }

  refreshFromData(data: ProjectDataSnapshot) {
    this.cards = data.cards;
    this.bundles = data.bundles;
    this.scopes = data.scopes;
    this.scopeRels = data.scopeRels;
    this.glueRels = data.glueRels;
    this.workingCopies = data.workingCopies;

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
