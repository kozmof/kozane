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
