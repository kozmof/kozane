import { describe, expect, it, vi } from "vitest";
import { HttpClient, type KozaneClient } from "../../src/client/index.js";
import { structureResults } from "../../../kozane/src/test-utils/structure-results.js";
const capabilities = {
  writable: true,
  taskspaces: false,
  persistent: true,
  externalWrites: false,
  auth: false,
};
const calls = {
  "namespaces.create": (b: KozaneClient) => b.namespaces.create({ name: "Namespace" }),
  "layers.create": (b: KozaneClient) => b.layers.create("n", { name: "Layer" }),
  "layers.rename": (b: KozaneClient) => b.layers.rename("n", "l", { name: "Layer" }),
  "layers.remove": (b: KozaneClient) => b.layers.remove("n", "l"),
  "layers.reorder": (b: KozaneClient) => b.layers.reorder("n", { layerIds: ["l"] }),
  "partitions.create": (b: KozaneClient) => b.partitions.create("n", { name: "Partition" }),
  "partitions.rename": (b: KozaneClient) => b.partitions.rename("n", "p", { name: "Partition" }),
  "partitions.remove": (b: KozaneClient) => b.partitions.remove("n", "p"),
} satisfies Record<keyof typeof structureResults, (b: KozaneClient) => Promise<unknown>>;
describe.each(Object.entries(calls))("%s response", (name, call) => {
  it("returns a decoded result after notifying committed-data subscribers", async () => {
    const value = structureResults[name as keyof typeof structureResults];
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
  it("rejects a malformed committed result while retaining its invalidation and never replaying", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: false }));
    const backend = new HttpClient({ capabilities, fetcher });
    const observed = vi.fn();
    const release = backend.subscribe(observed);
    await expect(call(backend)).rejects.toMatchObject({ code: "unavailable" });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(backend.version.revision).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
  });
});
