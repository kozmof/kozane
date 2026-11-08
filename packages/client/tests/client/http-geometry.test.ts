import { describe, expect, it, vi } from "vitest";
import { HttpClient, type KozaneClient } from "../../src/client/index.js";
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
  "scopes.create": (b: KozaneClient) => b.scopes.create(ns, { name: "Scope" }),
  "scopes.rename": (b: KozaneClient) => b.scopes.rename(ns, "s", { name: "Scope" }),
  "scopes.remove": (b: KozaneClient) => b.scopes.remove(ns, "s"),
  "scopes.addMembers": (b: KozaneClient) => b.scopes.addMembers(ns, "s", { cardIds: ["c"] }),
  "scopes.removeMembers": (b: KozaneClient) => b.scopes.removeMembers(ns, "s", { cardIds: ["c"] }),
  "scopes.createArea": (b: KozaneClient) => b.scopes.createArea(ns, "s", rect),
  "scopes.updateArea": (b: KozaneClient) => b.scopes.updateArea(ns, "s", "a", rect),
  "scopes.removeArea": (b: KozaneClient) => b.scopes.removeArea(ns, "s", "a"),
  "warps.create": (b: KozaneClient) => b.warps.create(ns, { posX: 1, posY: 2 }),
  "warps.update": (b: KozaneClient) => b.warps.update(ns, "w", { posX: 3, posY: 4 }),
  "warps.remove": (b: KozaneClient) => b.warps.remove(ns, "w"),
} satisfies Record<keyof typeof geometryResults, (b: KozaneClient) => Promise<unknown>>;
describe.each(Object.entries(calls))("%s response", (name, call) => {
  it("returns complete decoded results and one committed invalidation", async () => {
    const value = geometryResults[name as keyof typeof geometryResults];
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
  it("rejects malformed committed results after invalidating without replay", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: false }));
    const client = new HttpClient({ capabilities, fetcher });
    const observed = vi.fn();
    const release = client.subscribe(observed);
    await expect(call(client)).rejects.toMatchObject({ code: "unavailable" });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(client.version.revision).toBe(1);
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
    const client = new HttpClient({ capabilities, fetcher });
    await expect(calls[name](client)).rejects.toMatchObject({ code: "unavailable" });
    expect(client.version.revision).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
