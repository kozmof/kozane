import { createBackendBoardActions } from "./lib/actions/backend-board-actions.js";
import type { HttpBackend } from "$lib/backend/http-backend.js";
import { createBackendCardActions } from "./lib/actions/backend-card-actions.js";
import type { NamespaceState } from "./namespace-state.svelte.js";
import { createBoardActions } from "./lib/actions/board-actions.js";
import { createCardActions } from "./lib/actions/card-actions.js";
import { createScopeActions } from "./lib/actions/scope-actions.js";

/**
 * Every board mutation, bound to one namespace's state. Each group lives in its own module
 * under `lib/actions`. Optimistic updates roll back only what they changed.
 */
export function createNamespaceActions(
  state: NamespaceState,
  backend?: Pick<HttpBackend, "cards" | "glues" | "layers" | "partitions" | "warps">,
) {
  return {
    ...(backend ? createBackendCardActions(state, backend) : createCardActions(state)),
    ...(backend ? createBackendBoardActions(state, backend) : createBoardActions(state)),
    ...createScopeActions(state),
  };
}
