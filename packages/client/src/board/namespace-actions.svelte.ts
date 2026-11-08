import { createClientScopeActions } from "./lib/actions/backend-scope-actions.js";
import { createClientBoardActions } from "./lib/actions/backend-board-actions.js";
import type { KozaneClient } from "../backend/contract.js";
import { createClientCardActions } from "./lib/actions/backend-card-actions.js";
import type { NamespaceState } from "./namespace-state.svelte.js";

/**
 * Every board mutation, bound to one namespace's state. Each group lives in its own module
 * under `lib/actions`. Optimistic updates roll back only what they changed.
 */
export function createNamespaceActions(
  state: NamespaceState,
  backend: Pick<
    KozaneClient,
    "cards" | "glues" | "layers" | "partitions" | "warps" | "scopes" | "taskspaces"
  >,
) {
  return {
    ...createClientCardActions(state, backend),
    ...createClientBoardActions(state, backend),
    ...createClientScopeActions(state, backend),
  };
}
