import { describe, expect, it, vi } from "vitest";
import { HttpBackend, type KozaneBackend } from "./index.js";
import { cardResults } from "../../../../src/test-utils/card-results.js";
const capabilities = {
  writable: true,
  taskspaces: false,
  persistent: true,
  externalWrites: false,
  auth: false,
};
const ns = "n /";
const calls = {
  "cards.create": (b: KozaneBackend) => b.cards.create(ns, { partitionId: "p", content: "Text" }),
  "cards.update": (b: KozaneBackend) => b.cards.update(ns, "c", { width: null }),
  "cards.updatePositions": (b: KozaneBackend) =>
    b.cards.updatePositions(ns, { positions: [{ cardId: "c", posX: 1, posY: 2 }] }),
  "cards.remove": (b: KozaneBackend) => b.cards.remove(ns, { cardIds: ["c"] }),
  "cards.removeOne": (b: KozaneBackend) => b.cards.removeOne(ns, "c"),
  "cards.move": (b: KozaneBackend) =>
    b.cards.move(ns, { cardIds: ["c"], targetNamespaceId: "other" }),
  "cards.setLayer": (b: KozaneBackend) => b.cards.setLayer(ns, { cardIds: ["c"], layerId: "l" }),
  "cards.setPartition": (b: KozaneBackend) =>
    b.cards.setPartition(ns, { cardIds: ["c"], partitionId: "p" }),
  "cards.setStacking": (b: KozaneBackend) =>
    b.cards.setStacking(ns, { cardIds: ["c"], direction: "front" }),
  "cards.squash": (b: KozaneBackend) => b.cards.squash(ns, { cardId: "c" }),
  "glues.create": (b: KozaneBackend) => b.glues.create(ns, { cardIds: ["c", "d"] }),
  "glues.remove": (b: KozaneBackend) => b.glues.remove(ns, { cardIds: ["c"] }),
} satisfies Record<keyof typeof cardResults, (b: KozaneBackend) => Promise<unknown>>;
describe.each(Object.entries(calls))("%s response", (name, call) => {
  it("decodes complete results and publishes one committed invalidation", async () => {
    const value = cardResults[name as keyof typeof cardResults];
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
  it("rejects malformed committed results after invalidating, without replay", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: false }));
    const backend = new HttpBackend({ capabilities, fetcher });
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
  const backend = new HttpBackend({ capabilities, fetcher });
  const input: { content?: string; width: null } = { content: " edited ", width: null };
  const pending = backend.cards.update(ns, "c", input);
  delete input.content;
  input.width = null;
  finish(Response.json({ ok: true, stacking: [] }));
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  expect(backend.version.revision).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
