import { expect, it, vi } from "vitest";
import { NamespaceState } from "../../namespace-state.svelte.js";
import { HttpBackend } from "$lib/backend/http-backend.js";
import { createBackendBoardActions } from "./backend-board-actions";
import { data } from "../../page.fixtures.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: true,
  externalWrites: false,
  auth: false,
};
it("restores an optimistic layer rename and preserves the backend conflict message", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const layer = state.layers[0];
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const actions = createBackendBoardActions(state, new HttpBackend({ fetcher, capabilities }));
  const pending = actions.handleRenameLayer(layer.id, "Renamed");
  expect(state.layers[0].name).toBe("Renamed");
  expect(state.mutations.idle).toBe(false);
  finish(
    new Response('{"message":"Duplicate layer"}', {
      status: 400,
      headers: { "content-type": "application/json", "X-Kozane-Error-Code": "conflict" },
    }),
  );
  await pending;
  expect(state.layers[0].name).toBe(layer.name);
  expect(state.lastError).toBe("Duplicate layer");
  expect(state.mutations.idle).toBe(true);
});
it("adds a layer from stored backend position and selects it", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response('{"id":"created","name":"New","position":10,"isDefault":false}'),
    );
  await createBackendBoardActions(
    state,
    new HttpBackend({ fetcher, capabilities }),
  ).handleCreateLayer("New");
  expect(state.layers.find((layer) => layer.id === "created")?.position).toBe(10);
  expect(state.activeLayerId).toBe("created");
});
