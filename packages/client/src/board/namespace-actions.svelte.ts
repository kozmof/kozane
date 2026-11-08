import { createClientScopeActions } from "./lib/actions/client-scope-actions.js";
import { createClientBoardActions } from "./lib/actions/client-board-actions.js";
import type { KozaneClient } from "../client/contract.js";
import { createClientCardActions } from "./lib/actions/client-card-actions.js";
import type { NamespaceState } from "./namespace-state.svelte.js";

/**
 * Every board mutation, bound to one namespace's state. Each group lives in its own module
 * under `lib/actions`. Optimistic updates roll back only what they changed.
 */
export function createNamespaceActions(
  state: NamespaceState,
  client: Pick<
    KozaneClient,
    "cards" | "glues" | "layers" | "partitions" | "warps" | "scopes" | "taskspaces"
  >,
) {
  return {
    ...createClientCardActions(state, client),
    ...createClientBoardActions(state, client),
    ...createClientScopeActions(state, client),
  };
}
