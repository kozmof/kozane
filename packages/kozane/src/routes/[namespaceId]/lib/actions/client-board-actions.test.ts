import { expect, it, vi } from "vitest";
import { NamespaceState } from "../../../../../../client/src/board/namespace-state.svelte.js";
import { HttpClient } from "../../../../../../client/src/client/http-client.js";
import { createClientBoardActions } from "../../../../../../client/src/board/lib/actions/client-board-actions.js";
import { data } from "../../page.fixtures.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: true,
  externalWrites: false,
  auth: false,
};
it("restores an optimistic layer rename and preserves the client conflict message", async () => {
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
  const actions = createClientBoardActions(state, new HttpClient({ fetcher, capabilities }));
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
it("adds a layer from stored client position and selects it", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response('{"id":"created","name":"New","position":10,"isDefault":false}'),
    );
  await createClientBoardActions(
    state,
    new HttpClient({ fetcher, capabilities }),
  ).handleCreateLayer("New");
  expect(state.layers.find((layer) => layer.id === "created")?.position).toBe(10);
  expect(state.activeLayerId).toBe("created");
});
it("renames the default partition and preserves its identity", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const partition = state.partitions[0];
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  const actions = createClientBoardActions(state, new HttpClient({ fetcher, capabilities }));
  expect(await actions.handleRenamePartition(partition.id, " Inbox ")).toBeNull();
  expect(state.partitions[0]).toEqual({ ...partition, name: "Inbox" });
});
it("preserves partition names when renaming is rejected", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const partition = state.partitions[0];
  const fetcher = vi.fn(async () =>
    Response.json({ message: "Duplicate partition" }, { status: 400 }),
  );
  const actions = createClientBoardActions(state, new HttpClient({ fetcher, capabilities }));
  expect(await actions.handleRenamePartition(partition.id, "Research")).toBe("Duplicate partition");
  expect(state.partitions[0]).toEqual(partition);
});
