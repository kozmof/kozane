import { afterEach, expect, it, vi } from "vitest";
import { HttpBackend } from "../../src/backend/http-backend.js";
import { startDatasetView } from "../../src/backend/dataset-view.js";
import { tagDataset } from "./tags.fixtures.js";

afterEach(() => vi.useRealTimers());
it("shares polling throttle with subscribed reads without replaying rejected writes", async () => {
  vi.useFakeTimers();
  let now = 0;
  let wake = () => {};
  const stop = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (fetcher.mock.calls.length === 1)
      return new Response('{"message":"Wait"}', { status: 429, headers: { "retry-after": "2" } });
    return Response.json(path === "/api/changes" ? { token: "baseline" } : tagDataset());
  });
  const backend = new HttpBackend({
    fetcher,
    pollingInitialDelayMs: 60000,
    monotonicNow: () => now,
    capabilities: {
      writable: true,
      persistent: true,
      externalWrites: true,
      taskspaces: true,
      auth: false,
    },
    lifecycle: {
      visible: () => true,
      listen: (callback) => {
        wake = callback;
        return stop;
      },
    },
  });
  const apply = vi.fn();
  const release = startDatasetView({
    backend,
    dataset: "tags",
    read: () => backend.tags.get(),
    apply,
    isHidden: () => false,
    retryIntervalMs: 100,
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
    await expect(backend.namespaces.create({ name: "Rejected" })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 2000,
    });
    wake();
    now = 1999;
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledOnce();
    now = 2000;
    await vi.advanceTimersByTimeAsync(1);
    expect(apply).toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([path]) => String(path) === "/api/namespaces")).toBe(false);
    expect(fetcher.mock.calls.some(([path]) => String(path) === "/api/changes")).toBe(true);
  } finally {
    release();
  }
  expect(stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  const count = fetcher.mock.calls.length;
  wake();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(count);
});

it("publishes all workspace datasets when polling recovers without a token change", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "stable" }))
    .mockResolvedValueOnce(Response.json({ message: "Metadata unavailable" }, { status: 503 }))
    .mockImplementation(async () => Response.json({ token: "stable" }));
  const stop = vi.fn();
  const backend = new HttpBackend({
    fetcher,
    capabilities: {
      writable: true,
      persistent: true,
      externalWrites: true,
      taskspaces: true,
      auth: false,
    },
    lifecycle: { visible: () => true, listen: () => stop },
  });
  const observed = vi.fn();
  const release = backend.subscribe((event) => {
    expect(backend.version).toEqual({ generation: event.generation, revision: event.revision });
    observed(event);
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).toHaveBeenCalledOnce();
    const stamp = backend.version;
    await vi.advanceTimersByTimeAsync(1000);
    expect(observed).toHaveBeenCalledOnce();
    expect(backend.version).toBe(stamp);
    expect(backend.state).toMatchObject({ status: "ready", refreshError: { code: "unavailable" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(backend.state).toEqual({ status: "ready" });
    expect(observed.mock.calls[1][0]).toEqual({
      generation: 0,
      revision: 2,
      datasets: ["snapshot", "tags", "map", "namespaces", "warpDirectory"],
    });
    expect(stamp).toEqual({ generation: 0, revision: 1 });
  } finally {
    release();
  }
  expect(stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("retries transient polling failures on renewed subscriptions without shortening their throttle", async () => {
  vi.useFakeTimers();
  let now = 0;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ message: "Wait" }, { status: 429, headers: { "retry-after": "2" } }),
    )
    .mockImplementation(async () => Response.json({ token: "recovered" }));
  const backend = new HttpBackend({
    fetcher,
    monotonicNow: () => now,
    capabilities: {
      writable: true,
      persistent: true,
      externalWrites: true,
      taskspaces: true,
      auth: false,
    },
    lifecycle: { visible: () => true, listen: () => () => {} },
  });
  const observed = vi.fn();
  const release = backend.subscribe(observed);
  let releaseRetry = () => {};
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.state).toMatchObject({
      status: "ready",
      refreshError: { code: "rate_limited", retryAfterMs: 2000 },
    });
    expect(observed).not.toHaveBeenCalled();
    releaseRetry = backend.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    now = 1999;
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledOnce();
    now = 2000;
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(backend.state).toEqual({ status: "ready" });
    expect(observed).toHaveBeenCalledOnce();
  } finally {
    releaseRetry();
    release();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("expires HTTP validators when workspace changes or committed writes require a fresh server read", async () => {
  vi.useFakeTimers();
  const data = {
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
  const conditional: boolean[] = [];
  let token = "baseline",
    wake = () => {};
  const backend = new HttpBackend({
    capabilities: {
      writable: true,
      persistent: true,
      externalWrites: true,
      taskspaces: true,
      auth: false,
    },
    pollingInitialDelayMs: 60000,
    lifecycle: {
      visible: () => true,
      listen: (callback) => {
        wake = callback;
        return () => {};
      },
    },
    fetcher: async (input, init) => {
      const path = String(input);
      if (path === "/api/changes") return Response.json({ token });
      if (path === "/api/namespaces")
        return Response.json({ id: "new", name: "New", isDefault: false });
      conditional.push(new Headers(init?.headers).has("if-none-match"));
      return Response.json(data, { headers: { etag: '"same"' } });
    },
  });
  let result = await backend.snapshot("ns");
  expect((await backend.snapshot("ns", { validator: result.validator })).status).toBe("unchanged");
  expect(conditional.at(-1)).toBe(true);
  const release = backend.subscribe(() => {});
  try {
    wake();
    await vi.advanceTimersByTimeAsync(0);
    result = await backend.snapshot("ns", { validator: result.validator });
    expect(result.status).toBe("changed");
    expect(conditional.at(-1)).toBe(false);
    token = "conservative-next";
    wake();
    await vi.advanceTimersByTimeAsync(0);
    result = await backend.snapshot("ns", { validator: result.validator });
    expect(result.status).toBe("changed");
    expect(conditional.at(-1)).toBe(false);
    await backend.namespaces.create({ name: "New" });
    expect((await backend.snapshot("ns", { validator: result.validator })).status).toBe("changed");
    expect(conditional.at(-1)).toBe(false);
  } finally {
    release();
  }
  expect(vi.getTimerCount()).toBe(0);
});
