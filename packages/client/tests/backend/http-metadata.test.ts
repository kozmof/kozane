import { expect, it, vi } from "vitest";
import { HttpBackend } from "../../src/backend/http-backend.js";
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
  const backend = new HttpBackend({ capabilities, fetcher });
  const listener = vi.fn();
  const unsubscribe = backend.subscribe(listener);
  expect(await backend.namespaces.list()).toEqual([namespace]);
  expect(await backend.namespaces.get(namespace.id)).toEqual(namespace);
  expect(await backend.warpDirectory.get(namespace.id)).toEqual([warp]);
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/api/namespaces",
    "/api/namespaces/n%20%2F",
    "/n%20%2F/api/warp-directory",
  ]);
  expect(listener).not.toHaveBeenCalled();
  expect(backend.version).toEqual({ generation: 0, revision: 0 });
  unsubscribe();
});
it.each([
  ["list", [{ ...namespace, isDefault: 1 }]],
  ["get", { ...namespace, id: "wrong" }],
  ["warpDirectory", [{ id: "w" }]],
] as const)("rejects malformed %s responses at the backend boundary", async (operation, value) => {
  const backend = new HttpBackend({ capabilities, fetcher: async () => Response.json(value) });
  const listener = vi.fn();
  const unsubscribe = backend.subscribe(listener);
  const result =
    operation === "list"
      ? backend.namespaces.list()
      : operation === "get"
        ? backend.namespaces.get(namespace.id)
        : backend.warpDirectory.get(namespace.id);
  await expect(result).rejects.toMatchObject({ code: "unavailable" });
  expect(listener).not.toHaveBeenCalled();
  expect(backend.version).toEqual({ generation: 0, revision: 0 });
  unsubscribe();
});
