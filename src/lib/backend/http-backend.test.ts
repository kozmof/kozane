import { expect, it, vi } from "vitest";
import { tagDataset } from "./tags.fixtures.js";
import { HttpBackend } from "./http-backend";
const capabilities = {
  writable: true,
  persistent: true,
  externalWrites: false,
  taskspaces: true,
  auth: false,
};
it("routes opaque card IDs and publishes current stamps after successful mutation", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    );
  const backend = new HttpBackend({ fetcher, base: "/base", capabilities });
  const observed = vi.fn();
  backend.subscribe((event) => {
    expect(backend.version.revision).toBe(event.revision);
    observed(event);
  });
  await backend.cards.update("ns /x", "card /y", { content: "edited" }, { keepalive: true });
  expect(fetcher.mock.calls[0][0]).toBe("/base/ns%20%2Fx/api/cards/card%20%2Fy");
  expect(fetcher.mock.calls[0][1].method).toBe("PATCH");
  expect(observed).toHaveBeenCalledOnce();
  expect(observed.mock.calls[0][0].namespaceIds).toBeUndefined();
});
it("publishes nothing on rejected mutations and enforces read-only capabilities", async () => {
  const fetcher = vi.fn().mockImplementation(
    async () =>
      new Response('{"message":"invalid"}', {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  const backend = new HttpBackend({ fetcher, capabilities });
  const listener = vi.fn();
  backend.subscribe(listener);
  await expect(
    // @ts-expect-error Exercise runtime rejection of an untrusted non-string content value.
    backend.cards.create("ns", { partitionId: "part", content: NaN }),
  ).rejects.toMatchObject({
    code: "validation",
  });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    backend.cards.create("ns", { partitionId: "part", content: "x" }),
  ).rejects.toMatchObject({
    code: "validation",
  });
  expect(listener).not.toHaveBeenCalled();
  const readonly = new HttpBackend({ fetcher, capabilities: { ...capabilities, writable: false } });
  await expect(readonly.namespaces.create({ name: "new" })).rejects.toMatchObject({
    code: "read_only",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const snapshotData = {
  namespace: { id: "ns" },
  cards: [],
  partitions: [],
  layers: [],
  warps: [],
  inventories: [],
  scopes: [],
  scopeAreas: [],
  scopeRels: [],
  glueRels: [],
  taskspaces: [],
};
it("binds snapshot validators and translates ETag/304 without exposing HTTP", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify(snapshotData), { headers: { etag: '"one"' } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"one"' } }));
  const backend = new HttpBackend({ fetcher, capabilities });
  const first = await backend.snapshot("ns");
  expect(first.status).toBe("changed");
  expect(first.validator).not.toBe('"one"');
  expect(await backend.snapshot("ns", { validator: first.validator })).toEqual({
    status: "unchanged",
    validator: first.validator,
  });
  expect(new Headers(fetcher.mock.calls[1][1].headers).get("if-none-match")).toBe('"one"');
});
it("does not reuse a validator across instances or namespaces and never hides a missing namespace", async () => {
  const fetcher = vi.fn().mockImplementation(async (url: string) =>
    url.includes("other")
      ? new Response(JSON.stringify({ ...snapshotData, namespace: { id: "other" } }), {
          headers: { etag: '"one"' },
        })
      : new Response(JSON.stringify(snapshotData), { headers: { etag: '"one"' } }),
  );
  const backend = new HttpBackend({ fetcher, capabilities });
  const first = await backend.snapshot("ns");
  expect((await backend.snapshot("other", { validator: first.validator })).status).toBe("changed");
  expect(new Headers(fetcher.mock.calls[1][1].headers).has("if-none-match")).toBe(false);
  const another = new HttpBackend({ fetcher, capabilities });
  expect((await another.snapshot("ns", { validator: first.validator })).status).toBe("changed");
  expect(new Headers(fetcher.mock.calls[2][1].headers).has("if-none-match")).toBe(false);
  fetcher.mockResolvedValueOnce(
    new Response('{"message":"Namespace not found"}', {
      status: 404,
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(backend.snapshot("ns", { validator: first.validator })).rejects.toMatchObject({
    code: "not_found",
  });
});
it("rejects malformed snapshot data before publishing a validator", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"namespace":{"id":"ns"}}'));
  await expect(new HttpBackend({ fetcher, capabilities }).snapshot("ns")).rejects.toMatchObject({
    code: "unavailable",
  });
});
it("routes structure membership area and inventory operations to retained endpoints", async () => {
  const fetcher = vi.fn().mockImplementation(async (path: string) =>
    Response.json(
      path.endsWith("/areas/area")
        ? {
            id: "area",
            namespaceId: "ns",
            scopeId: "scope",
            posX: 0,
            posY: 0,
            width: 100,
            height: 100,
          }
        : { ok: true },
    ),
  );
  const backend = new HttpBackend({ fetcher, capabilities });
  await backend.glues.create("ns", { cardIds: ["a", "b"] });
  await backend.layers.reorder("ns", { layerIds: ["layer"] });
  await backend.partitions.rename("ns", "part", { name: "Name" });
  await backend.scopes.addMembers("ns", "scope", { cardIds: ["a"] });
  await backend.scopes.updateArea("ns", "scope", "area", {
    posX: 0,
    posY: 0,
    width: 100,
    height: 100,
  });
  await backend.warps.remove("ns", "warp");
  await backend.inventories.stow("ns", "tray", { cardIds: ["a"] });
  await backend.inventories.take("ns", { cards: [{ cardId: "a" }] });
  expect(fetcher.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
    ["/ns/api/glues", "POST"],
    ["/ns/api/layers", "PATCH"],
    ["/ns/api/partitions/part", "PATCH"],
    ["/ns/api/scopes/scope/members", "POST"],
    ["/ns/api/scopes/scope/areas/area", "PATCH"],
    ["/ns/api/warps/warp", "DELETE"],
    ["/ns/api/inventories/tray/cards", "POST"],
    ["/ns/api/inventories/take", "POST"],
  ]);
});

it("routes workspace view reads without dispatching content-bearing tag filters", async () => {
  const fetcher = vi.fn().mockImplementation(
    async (path: string) =>
      new Response(
        JSON.stringify(
          path.startsWith("/api/tags")
            ? tagDataset()
            : path.endsWith("/warp-directory")
              ? []
              : {
                  namespaces: [],
                  partitions: [],
                  activity: [],
                  scopes: [],
                  partitionUsage: [],
                  namespaceUsage: [],
                  tags: { hits: [], cardData: {}, cardNamespaces: {}, truncated: false },
                },
        ),
      ),
  );
  const backend = new HttpBackend({ fetcher, capabilities });
  const changed = vi.fn();
  backend.subscribe(changed);
  await backend.tags.get("opaque /ns");
  await backend.map.get();
  await backend.warpDirectory.get("opaque /ns");
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/api/tags?namespaceId=opaque%20%2Fns",
    "/api/map",
    "/opaque%20%2Fns/api/warp-directory",
  ]);
  expect(changed).not.toHaveBeenCalled();
});

it("owns workspace polling without a mounted board and cleans up on final unsubscribe", async () => {
  vi.useFakeTimers();
  try {
    const stop = vi.fn();
    const fetcher = vi.fn().mockImplementation(async () => new Response('{"token":"baseline"}'));
    const backend = new HttpBackend({
      fetcher,
      capabilities: { ...capabilities, externalWrites: true },
      lifecycle: { visible: () => true, listen: () => stop },
    });
    const listener = vi.fn();
    const unsubscribe = backend.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls[0][0]).toBe("/api/changes");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].datasets).toContain("map");
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0].datasets).toEqual(["tags", "snapshot"]);
    unsubscribe();
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
