import { expect, it, vi } from "vitest";
import { NamespaceState } from "../../../../../../client/src/board/namespace-state.svelte.js";
import { HttpClient } from "../../../../../../client/src/client/http-client.js";
import { createClientCardActions } from "../../../../../../client/src/board/lib/actions/backend-card-actions.js";
import { data } from "../../page.fixtures.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: true,
  externalWrites: false,
  auth: false,
};
it("keeps mutation activity open and restores optimistic deletion after backend rejection", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const original = state.cards[0];
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const actions = createClientCardActions(state, new HttpClient({ fetcher, capabilities }));
  const pending = actions.handleDeleteSelected([original.id]);
  expect(state.mutations.idle).toBe(false);
  expect(state.cards.some((card) => card.id === original.id)).toBe(false);
  finish(
    new Response('{"message":"rejected"}', {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  );
  await pending;
  expect(state.mutations.idle).toBe(true);
  expect(state.cards.some((card) => card.id === original.id)).toBe(true);
  expect(state.lastError).toBe("Failed to delete cards");
});
it("applies successful glue results through typed backend operations", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const ids = state.cards.slice(0, 2).map((card) => card.id);
  const fetcher = vi
    .fn()
    .mockImplementation(async () => new Response('{"glueId":"joined","clearedCardIds":[]}'));
  const actions = createClientCardActions(state, new HttpClient({ fetcher, capabilities }));
  await actions.handleGlueSelected(ids);
  expect(
    state.cards.filter((card) => ids.includes(card.id)).every((card) => card.glueId === "joined"),
  ).toBe(true);
  expect(state.mutations.idle).toBe(true);
});
