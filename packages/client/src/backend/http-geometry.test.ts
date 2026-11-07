import { describe, expect, it, vi } from "vitest";
import { HttpBackend, type KozaneBackend } from "./index.js";
import { geometryResults } from "../../../kozane/src/test-utils/geometry-results.js";
const capabilities = {
  writable: true,
  taskspaces: false,
  persistent: true,
  externalWrites: false,
  auth: false,
};
const ns = "n /";
const rect = { posX: 1, posY: 2, width: 100, height: 100 };
const calls = {
  "scopes.create": (b: KozaneBackend) => b.scopes.create(ns, { name: "Scope" }),
  "scopes.rename": (b: KozaneBackend) => b.scopes.rename(ns, "s", { name: "Scope" }),
  "scopes.remove": (b: KozaneBackend) => b.scopes.remove(ns, "s"),
  "scopes.addMembers": (b: KozaneBackend) => b.scopes.addMembers(ns, "s", { cardIds: ["c"] }),
  "scopes.removeMembers": (b: KozaneBackend) => b.scopes.removeMembers(ns, "s", { cardIds: ["c"] }),
  "scopes.createArea": (b: KozaneBackend) => b.scopes.createArea(ns, "s", rect),
  "scopes.updateArea": (b: KozaneBackend) => b.scopes.updateArea(ns, "s", "a", rect),
  "scopes.removeArea": (b: KozaneBackend) => b.scopes.removeArea(ns, "s", "a"),
  "warps.create": (b: KozaneBackend) => b.warps.create(ns, { posX: 1, posY: 2 }),
  "warps.update": (b: KozaneBackend) => b.warps.update(ns, "w", { posX: 3, posY: 4 }),
  "warps.remove": (b: KozaneBackend) => b.warps.remove(ns, "w"),
} satisfies Record<keyof typeof geometryResults, (b: KozaneBackend) => Promise<unknown>>;
describe.each(Object.entries(calls))("%s response", (name, call) => {
  it("returns complete decoded results and one committed invalidation", async () => {
    const value = geometryResults[name as keyof typeof geometryResults];
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
  it("rejects malformed committed results after invalidating without replay", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: false }));
    const backend = new HttpBackend({ capabilities, fetcher });
    const observed = vi.fn();
    const release = backend.subscribe(observed);
    await expect(call(backend)).rejects.toMatchObject({ code: "unavailable" });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(backend.version.revision).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
  });
});
it.each([
  ["scopes.rename", { ...geometryResults["scopes.rename"], id: "other" }],
  ["scopes.createArea", { ...geometryResults["scopes.createArea"], scopeId: "other" }],
  ["scopes.updateArea", { ...geometryResults["scopes.updateArea"], id: "other" }],
  ["scopes.updateArea", { ...geometryResults["scopes.updateArea"], namespaceId: "other" }],
  ["warps.create", { ...geometryResults["warps.create"], namespaceId: "other" }],
  ["warps.update", { ...geometryResults["warps.update"], id: "other" }],
] as const)(
  "rejects mismatched %s identities while preserving its committed revision",
  async (name, value) => {
    const fetcher = vi.fn(async () => Response.json(value));
    const backend = new HttpBackend({ capabilities, fetcher });
    await expect(calls[name](backend)).rejects.toMatchObject({ code: "unavailable" });
    expect(backend.version.revision).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
