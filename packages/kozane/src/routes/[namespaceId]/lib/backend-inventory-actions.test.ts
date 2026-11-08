import { expect, it, vi } from "vitest";
import { NamespaceState } from "../../../../../client/src/board/namespace-state.svelte.js";
import { HttpClient } from "../../../../../client/src/client/http-client.js";
import { createClientInventoryActions } from "../../../../../client/src/board/lib/backend-inventory-actions.js";
import { data } from "../page.fixtures.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: true,
  externalWrites: false,
  auth: false,
};
it("restores an optimistic stow after a backend refusal and holds activity until rollback", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const id = state.cards[0].id;
  let finish!: (response: Response) => void;
  const fetcher = vi.fn().mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const actions = createClientInventoryActions(state, new HttpClient({ fetcher, capabilities }));
  const pending = actions.stow([id], "bag", 0);
  expect(state.cards[0].inventory?.id).toBe("bag");
  expect(state.mutations.idle).toBe(false);
  finish(
    new Response('{"message":"Inventory full"}', {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  );
  await pending;
  expect(state.cards[0].inventory).toBeNull();
  expect(state.lastError).toBe("Inventory full");
  expect(state.mutations.idle).toBe(true);
});
it("uses backend-assigned slots and clears glue after a successful stow", async () => {
  const state = new NamespaceState();
  state.resetFromData(data);
  const id = state.cards[0].id;
  state.cards = state.cards.map((card) => (card.id === id ? { ...card, glueId: "joined" } : card));
  state.glueRels = [{ cardId: id, glueId: "joined" }];
  const fetcher = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          placements: [{ cardId: id, inventoryId: "bag", slot: 10 }],
          clearedCardIds: [id],
        }),
      ),
  );
  await createClientInventoryActions(state, new HttpClient({ fetcher, capabilities })).stow(
    [id],
    "bag",
    null,
  );
  expect(state.cards[0].inventory).toEqual({ id: "bag", slot: 10 });
  expect(state.cards[0].glueId).toBeNull();
  expect(state.glueRels).toEqual([]);
});
