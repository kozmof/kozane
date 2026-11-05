import { describe, expect, it, vi } from "vitest";
import { HttpBackend, type KozaneBackend } from "./index.js";
import { inventoryResults } from "../../test-utils/inventory-results.js";
const capabilities = {
  writable: true,
  taskspaces: false,
  persistent: true,
  externalWrites: false,
  auth: false,
};
const ns = "n /";
const calls = {
  "inventories.create": (b: KozaneBackend) => b.inventories.create(ns, { posX: 1, posY: 2 }),
  "inventories.update": (b: KozaneBackend) => b.inventories.update(ns, "i", { name: "Tray" }),
  "inventories.remove": (b: KozaneBackend) => b.inventories.remove(ns, "i"),
  "inventories.stow": (b: KozaneBackend) => b.inventories.stow(ns, "i", { cardIds: ["c"] }),
  "inventories.take": (b: KozaneBackend) => b.inventories.take(ns, { cards: [{ cardId: "c" }] }),
} satisfies Record<keyof typeof inventoryResults, (b: KozaneBackend) => Promise<unknown>>;
describe.each(Object.entries(calls))("%s response", (name, call) => {
  it("decodes complete results and publishes exactly one committed invalidation", async () => {
    const value = inventoryResults[name as keyof typeof inventoryResults];
    const fetcher = vi.fn(async () => Response.json(value));
    const backend = new HttpBackend({ capabilities, fetcher });
    const observed = vi.fn();
    const release = backend.subscribe(observed);
    expect(await call(backend)).toEqual(value);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(backend.version.revision).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
  });
  it("rejects malformed committed data after invalidating, without replay", async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const backend = new HttpBackend({ capabilities, fetcher });
    await expect(call(backend)).rejects.toMatchObject({ code: "unavailable" });
    expect(backend.version.revision).toBe(1);
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
  const backend = new HttpBackend({ capabilities, fetcher });
  const input = { cards: [{ cardId: "c", posX: 900, posY: -10 }] };
  const pending = backend.inventories.take(ns, input);
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
  const backend = new HttpBackend({ capabilities, fetcher });
  await expect(backend.inventories.take(ns, input)).rejects.toMatchObject({ code: "validation" });
  const readonly = new HttpBackend({ capabilities: { ...capabilities, writable: false }, fetcher });
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
  const backend = new HttpBackend({ capabilities, fetcher: async () => Response.json(value) });
  await expect(calls[name](backend)).rejects.toMatchObject({ code: "unavailable" });
  expect(backend.version.revision).toBe(1);
});
