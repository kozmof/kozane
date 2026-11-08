import { expect, it, vi } from "vitest";
import { HttpClient } from "../../src/client/http-client.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: false,
  externalWrites: false,
  auth: false,
};
const namespace = { id: "n /", name: "Board", isDefault: true };
it("validates namespace and warp reads without invalidating data", async () => {
  const warp = {
    id: "w",
    namespaceId: "other",
    namespaceName: "Other",
    isCurrent: false,
    label: 1,
    posX: 2,
    posY: 3,
    hint: null,
  };
  const fetcher = vi.fn(async (path: RequestInfo | URL) => {
    const value = String(path).endsWith("warp-directory")
      ? [warp]
      : String(path).endsWith("namespaces")
        ? [namespace]
        : namespace;
    return Response.json(value);
  });
  const client = new HttpClient({ capabilities, fetcher });
  const listener = vi.fn();
  const unsubscribe = client.subscribe(listener);
  expect(await client.namespaces.list()).toEqual([namespace]);
  expect(await client.namespaces.get(namespace.id)).toEqual(namespace);
  expect(await client.warpDirectory.get(namespace.id)).toEqual([warp]);
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/api/namespaces",
    "/api/namespaces/n%20%2F",
    "/n%20%2F/api/warp-directory",
  ]);
  expect(listener).not.toHaveBeenCalled();
  expect(client.version).toEqual({ generation: 0, revision: 0 });
  unsubscribe();
});
it.each([
  ["list", [{ ...namespace, isDefault: 1 }]],
  ["get", { ...namespace, id: "wrong" }],
  ["warpDirectory", [{ id: "w" }]],
] as const)("rejects malformed %s responses at the client boundary", async (operation, value) => {
  const client = new HttpClient({ capabilities, fetcher: async () => Response.json(value) });
  const listener = vi.fn();
  const unsubscribe = client.subscribe(listener);
  const result =
    operation === "list"
      ? client.namespaces.list()
      : operation === "get"
        ? client.namespaces.get(namespace.id)
        : client.warpDirectory.get(namespace.id);
  await expect(result).rejects.toMatchObject({ code: "unavailable" });
  expect(listener).not.toHaveBeenCalled();
  expect(client.version).toEqual({ generation: 0, revision: 0 });
  unsubscribe();
});
