import { afterEach, expect, it, vi } from "vitest";
import { HttpBackend } from "./http-backend.js";
import { startDatasetView } from "./dataset-view.js";
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
    expect(backend.state.status).toBe("ready");
    await vi.advanceTimersByTimeAsync(1000);
    expect(observed).toHaveBeenCalledTimes(2);
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
