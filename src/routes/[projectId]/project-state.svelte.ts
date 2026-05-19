import type { CardWithGlue, Bundle, Scope, ScopeRel, GlueRel, WorkingCopy } from "$lib/types";

export class ProjectState {
  projectId = $state("");
  fetcher: typeof fetch = fetch;

  cards = $state<CardWithGlue[]>([]);
  bundles = $state<Bundle[]>([]);
  scopes = $state<Scope[]>([]);
  scopeRels = $state<ScopeRel[]>([]);
  glueRels = $state<GlueRel[]>([]);
  workingCopies = $state<WorkingCopy[]>([]);

  selectedCards = $state(new Set<string>());
  primarySelectedId = $state<string | null>(null);
  composerCard = $state<CardWithGlue | null>(null);

  activeBundle = $state<string | null>(null);
  activeScope = $state<string | null>(null);

  newBundleName = $state("");
  newScopeName = $state("");
  newWcName = $state("");

  lastError = $state<string | null>(null);

  setError(message: string) {
    this.lastError = message;
  }
}
