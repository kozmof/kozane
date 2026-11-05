import { afterEach, expect, it, vi } from "vitest";
import { NamespaceIndex } from "./namespace-index.svelte.js";
import { HttpBackend } from "./http-backend.js";
import { BackendSignals } from "./signals.js";
const initial = [{ id: "one", name: "One", isDefault: true }];
afterEach(() => vi.useRealTimers());
function fixture() {
  const signals = new BackendSignals({ status: "ready" });
  const list = vi.fn().mockResolvedValue(initial);
  const backend = {
    get version() {
      return signals.version;
    },
    get state() {
      return signals.state;
    },
    subscribe: signals.subscribe.bind(signals),
    subscribeState: signals.subscribeState.bind(signals),
    namespaces: { list, get: vi.fn(), create: vi.fn() },
  };
  const index = new NamespaceIndex(backend, initial);
  return { signals, backend, index, list };
}
it("subscribes before reading and rejects a response superseded by a commit", async () => {
  vi.useFakeTimers();
  const { signals, index, list } = fixture();
  let finish!: (value: typeof initial) => void;
  list
    .mockImplementationOnce(() => {
      signals.publish(["namespaces"]);
      return new Promise((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValueOnce([]);
  const stop = index.start();
  finish([{ ...initial[0], name: "stale" }]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(index.namespaces).toEqual([]);
  expect(list).toHaveBeenCalledTimes(2);
  stop();
  signals.publish(["namespaces"]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(list).toHaveBeenCalledTimes(2);
});
it("retains rows on failures and rejects late reads after shutdown", async () => {
  vi.useFakeTimers();
  const { index, list } = fixture();
  list.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([{}]);
  const stop = index.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(index.namespaces).toEqual(initial);
  let finish!: (value: typeof initial) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  stop();
  finish([]);
  await Promise.resolve();
  expect(index.namespaces).toEqual(initial);
});
it("rejects an old-generation read until the backend is ready again", async () => {
  vi.useFakeTimers();
  const { index, signals, list } = fixture();
  let finish!: (value: typeof initial) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stop = index.start();
  signals.transition({ status: "recovering" });
  signals.publish(["namespaces"], undefined, true);
  finish([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(index.namespaces).toEqual(initial);
  expect(list).toHaveBeenCalledOnce();
  signals.transition({ status: "ready" });
  await Promise.resolve();
  expect(list).toHaveBeenCalledTimes(2);
  stop();
});
it("creates through the HTTP backend, coalesces duplicate submissions and reports validation errors", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const backend = new HttpBackend({
    fetcher,
    capabilities: {
      writable: true,
      persistent: true,
      taskspaces: false,
      externalWrites: false,
      auth: false,
    },
  });
  const index = new NamespaceIndex(backend, initial);
  const pending = index.create("   ");
  expect(index.submitting).toBe(true);
  expect(await index.create("Other")).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
  finish(
    new Response('{"message":"name is required"}', {
      status: 400,
      headers: { "content-type": "application/json", "X-Kozane-Error-Code": "validation" },
    }),
  );
  expect(await pending).toBe(false);
  expect(index.submitting).toBe(false);
  expect(index.error).toBe("Namespace name is required.");
  expect(fetcher.mock.calls[0][0]).toBe("/api/namespaces");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ name: "" });
});
