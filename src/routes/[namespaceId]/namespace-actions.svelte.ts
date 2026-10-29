import type { NamespaceState } from "./namespace-state.svelte.js";
import { createBoardActions } from "./lib/actions/board-actions.js";
import { createCardActions } from "./lib/actions/card-actions.js";
import { createScopeActions } from "./lib/actions/scope-actions.js";

/**
 * Every board mutation, bound to one namespace's state. Each group lives in its own module
 * under `lib/actions`. Optimistic updates roll back only what they changed.
 */
export function createNamespaceActions(state: NamespaceState) {
  return {
    ...createCardActions(state),
    ...createBoardActions(state),
    ...createScopeActions(state),
  };
}
