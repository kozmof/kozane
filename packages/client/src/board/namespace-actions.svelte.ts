import { createBackendScopeActions } from "./lib/actions/backend-scope-actions.js";
import { createBackendBoardActions } from "./lib/actions/backend-board-actions.js";
import type { KozaneBackend } from "../backend/contract.js";
import { createBackendCardActions } from "./lib/actions/backend-card-actions.js";
import type { NamespaceState } from "./namespace-state.svelte.js";

/**
 * Every board mutation, bound to one namespace's state. Each group lives in its own module
 * under `lib/actions`. Optimistic updates roll back only what they changed.
 */
export function createNamespaceActions(
  state: NamespaceState,
  backend: Pick<
    KozaneBackend,
    "cards" | "glues" | "layers" | "partitions" | "warps" | "scopes" | "taskspaces"
  >,
) {
  return {
    ...createBackendCardActions(state, backend),
    ...createBackendBoardActions(state, backend),
    ...createBackendScopeActions(state, backend),
  };
}
