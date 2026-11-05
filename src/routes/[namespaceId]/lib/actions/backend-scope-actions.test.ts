import { expect, it, vi } from "vitest";
import { NamespaceState } from "../../namespace-state.svelte.js";
import { HttpBackend } from "$lib/backend/http-backend.js";
import { createBackendScopeActions } from "./backend-scope-actions";
import { data } from "../../page.fixtures.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: true,
  externalWrites: false,
  auth: false,
};
it("answers unsupported taskspaces without sending a request", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const fetcher = vi.fn();
  const backend = new HttpBackend({
    fetcher,
    capabilities: { ...capabilities, taskspaces: false },
  });
  expect(backend.taskspaces).toBeUndefined();
  expect(
    await createBackendScopeActions(state, backend).createTaskspace("scope-1", "Directory"),
  ).toEqual({ error: "Taskspaces are not available" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(state.mutations.idle).toBe(true);
});
it("uses stored scope-area geometry and keeps membership operations on the shared backend", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const fetcher = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          id: "area",
          scopeId: "scope-1",
          namespaceId: state.namespaceId,
          posX: 0,
          posY: 0,
          width: 100,
          height: 100,
        }),
      ),
  );
  await createBackendScopeActions(
    state,
    new HttpBackend({ fetcher, capabilities }),
  ).handleCreateScopeArea("scope-1", { posX: -20, posY: -20, width: 100, height: 100 });
  expect(state.scopeAreas[0]).toMatchObject({ id: "area", posX: 0, posY: 0 });
  expect(state.mutations.idle).toBe(true);
});
