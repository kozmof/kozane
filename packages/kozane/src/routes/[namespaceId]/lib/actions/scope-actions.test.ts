import { describe, expect, it } from "vitest";
import { HttpClient } from "../../../../../../client/src/backend/http-client.js";
import { NamespaceState } from "../../../../../../client/src/board/namespace-state.svelte.js";
import { createClientScopeActions } from "../../../../../../client/src/board/lib/actions/backend-scope-actions.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: true,
  externalWrites: false,
  auth: false,
};
function setup(fetcher: typeof fetch) {
  const state = new NamespaceState();
  state.namespaceId = "namespace-1";
  state.taskspaces = [
    { id: "t1", name: "draft", scopeId: "s1", path: "tasks/draft", pathKind: "workspace_relative" },
  ];
  const backend = new HttpClient({ capabilities, fetcher });
  return { state, actions: createClientScopeActions(state, backend) };
}
describe("scope actions used by the file browser", () => {
  it("answers a backend network reason instead of throwing", async () => {
    const { state, actions } = setup(async () => {
      throw new TypeError("Failed to fetch");
    });
    const failure = { error: "Unable to reach the backend" };
    expect(await actions.createScope("Notes")).toEqual(failure);
    expect(await actions.renameScope("s1", "Notes")).toEqual(failure);
    expect(await actions.removeScope("s1")).toEqual(failure);
    expect(await actions.createTaskspace("s1", "draft")).toEqual(failure);
    expect(await actions.renameTaskspace("t1", "final")).toEqual(failure);
    expect(await actions.deleteTaskspace("t1")).toEqual(failure);
    expect(state.taskspaces).toHaveLength(1);
    expect(state.mutations.idle).toBe(true);
  });
});
describe("deleteTaskspace", () => {
  it("passes on the validated directory outcome", async () => {
    const { state, actions } = setup(async () => Response.json({ ok: true, directory: "kept" }));
    expect(await actions.deleteTaskspace("t1")).toEqual({ directory: "kept" });
    expect(state.taskspaces).toEqual([]);
  });
  it("keeps the taskspace when the backend cannot validate its directory outcome", async () => {
    const { state, actions } = setup(async () => Response.json({ ok: true }));
    expect(await actions.deleteTaskspace("t1")).toEqual({ error: "Invalid taskspace response" });
    expect(state.taskspaces).toHaveLength(1);
    expect(state.mutations.idle).toBe(true);
  });
});
