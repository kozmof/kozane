import { describe, expect, it, vi } from "vitest";
import { HttpClient, type KozaneClient } from "../../src/client/index.js";
import { inventoryResults } from "../../../kozane/src/test-utils/inventory-results.js";
const capabilities = {
  writable: true,
  taskspaces: false,
  persistent: true,
  externalWrites: false,
  auth: false,
};
const ns = "n /";
const calls = {
  "inventories.create": (b: KozaneClient) => b.inventories.create(ns, { posX: 1, posY: 2 }),
  "inventories.update": (b: KozaneClient) => b.inventories.update(ns, "i", { name: "Tray" }),
  "inventories.remove": (b: KozaneClient) => b.inventories.remove(ns, "i"),
  "inventories.stow": (b: KozaneClient) => b.inventories.stow(ns, "i", { cardIds: ["c"] }),
  "inventories.take": (b: KozaneClient) => b.inventories.take(ns, { cards: [{ cardId: "c" }] }),
} satisfies Record<keyof typeof inventoryResults, (b: KozaneClient) => Promise<unknown>>;
describe.each(Object.entries(calls))("%s response", (name, call) => {
  it("decodes complete results and publishes exactly one committed invalidation", async () => {
    const value = inventoryResults[name as keyof typeof inventoryResults];
    const fetcher = vi.fn(async () => Response.json(value));
    const client = new HttpClient({ capabilities, fetcher });
    const observed = vi.fn();
    const release = client.subscribe(observed);
    expect(await call(client)).toEqual(value);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(client.version.revision).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
  });
  it("rejects malformed committed data after invalidating, without replay", async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const client = new HttpClient({ capabilities, fetcher });
    await expect(call(client)).rejects.toMatchObject({ code: "unavailable" });
    expect(client.version.revision).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
it("checks take results against the prepared request rather than caller edits during dispatch", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const client = new HttpClient({ capabilities, fetcher });
  const input = { cards: [{ cardId: "c", posX: 900, posY: -10 }] };
  const pending = client.inventories.take(ns, input);
  input.cards[0].cardId = "other";
  finish(Response.json({ cards: [{ cardId: "c", posX: 400, posY: 0 }] }));
  expect(await pending).toEqual({ cards: [{ cardId: "c", posX: 400, posY: 0 }] });
  expect(
    JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)).cards[0]
      .cardId,
  ).toBe("c");
});
it("rejects accessors without invoking them or dispatching, retaining read-only precedence", async () => {
  const getter = vi.fn(() => [{ cardId: "c" }]);
  const input = Object.defineProperty({}, "cards", { enumerable: true, get: getter }) as {
    cards: { cardId: string }[];
  };
  const fetcher = vi.fn();
  const client = new HttpClient({ capabilities, fetcher });
  await expect(client.inventories.take(ns, input)).rejects.toMatchObject({ code: "validation" });
  const readonly = new HttpClient({ capabilities: { ...capabilities, writable: false }, fetcher });
  await expect(readonly.inventories.take(ns, input)).rejects.toMatchObject({ code: "read_only" });
  expect(getter).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  ["inventories.create", { ...inventoryResults["inventories.create"], namespaceId: "other" }],
  ["inventories.update", { ...inventoryResults["inventories.update"], id: "other" }],
  [
    "inventories.stow",
    { placements: [{ cardId: "c", inventoryId: "other", slot: 0 }], clearedCardIds: [] },
  ],
  ["inventories.take", { cards: [{ cardId: "other" }] }],
] as const)("rejects incomplete or mismatched %s results", async (name, value) => {
  const client = new HttpClient({ capabilities, fetcher: async () => Response.json(value) });
  await expect(calls[name](client)).rejects.toMatchObject({ code: "unavailable" });
  expect(client.version.revision).toBe(1);
});
