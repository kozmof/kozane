import { describe, expect, it, vi } from "vitest";
import { HttpClient, type KozaneClient } from "../../src/backend/index.js";
import { cardResults } from "../../../kozane/src/test-utils/card-results.js";
const capabilities = {
  writable: true,
  taskspaces: false,
  persistent: true,
  externalWrites: false,
  auth: false,
};
const ns = "n /";
const calls = {
  "cards.create": (b: KozaneClient) => b.cards.create(ns, { partitionId: "p", content: "Text" }),
  "cards.update": (b: KozaneClient) => b.cards.update(ns, "c", { width: null }),
  "cards.updatePositions": (b: KozaneClient) =>
    b.cards.updatePositions(ns, { positions: [{ cardId: "c", posX: 1, posY: 2 }] }),
  "cards.remove": (b: KozaneClient) => b.cards.remove(ns, { cardIds: ["c"] }),
  "cards.removeOne": (b: KozaneClient) => b.cards.removeOne(ns, "c"),
  "cards.move": (b: KozaneClient) =>
    b.cards.move(ns, { cardIds: ["c"], targetNamespaceId: "other" }),
  "cards.setLayer": (b: KozaneClient) => b.cards.setLayer(ns, { cardIds: ["c"], layerId: "l" }),
  "cards.setPartition": (b: KozaneClient) =>
    b.cards.setPartition(ns, { cardIds: ["c"], partitionId: "p" }),
  "cards.setStacking": (b: KozaneClient) =>
    b.cards.setStacking(ns, { cardIds: ["c"], direction: "front" }),
  "cards.squash": (b: KozaneClient) => b.cards.squash(ns, { cardId: "c" }),
  "glues.create": (b: KozaneClient) => b.glues.create(ns, { cardIds: ["c", "d"] }),
  "glues.remove": (b: KozaneClient) => b.glues.remove(ns, { cardIds: ["c"] }),
} satisfies Record<keyof typeof cardResults, (b: KozaneClient) => Promise<unknown>>;
describe.each(Object.entries(calls))("%s response", (name, call) => {
  it("decodes complete results and publishes one committed invalidation", async () => {
    const value = cardResults[name as keyof typeof cardResults];
    const fetcher = vi.fn(async () => Response.json(value));
    const backend = new HttpClient({ capabilities, fetcher });
    const observed = vi.fn();
    const release = backend.subscribe(observed);
    expect(await call(backend)).toEqual(value);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(backend.version.revision).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
  });
  it("rejects malformed committed results after invalidating, without replay", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: false }));
    const backend = new HttpClient({ capabilities, fetcher });
    await expect(call(backend)).rejects.toMatchObject({ code: "unavailable" });
    expect(backend.version.revision).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
it("validates normalized content against a prepared request even if the caller changes it", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const backend = new HttpClient({ capabilities, fetcher });
  const input: { content?: string; width: null } = { content: " edited ", width: null };
  const pending = backend.cards.update(ns, "c", input);
  delete input.content;
  input.width = null;
  finish(Response.json({ ok: true, stacking: [] }));
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  expect(backend.version.revision).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
