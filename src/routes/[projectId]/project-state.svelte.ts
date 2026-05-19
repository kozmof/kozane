import type { CardWithGlue, Bundle, Scope, ScopeRel, GlueRel, WorkingCopySummary } from "$lib/types";

export class SelectionState {
  selectedCards = $state(new Set<string>());
  primarySelectedId = $state<string | null>(null);
  composerCard = $state<CardWithGlue | null>(null);
}

export class SidebarState {
  activeBundle = $state<string | null>(null);
  activeScope = $state<string | null>(null);
  newBundleName = $state("");
  newScopeName = $state("");
  newWcName = $state("");
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
}
