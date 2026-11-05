import { afterEach, expect, it, vi } from "vitest";
import { BackendSignals } from "./signals";
import { startSnapshotView } from "./snapshot-view";
import type { SnapshotData, SnapshotResult } from "./contract";
const data: SnapshotData = {
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
afterEach(() => vi.useRealTimers());
function fixture() {
  const signals = new BackendSignals({ status: "ready" });
  const snapshot = vi
    .fn<() => Promise<SnapshotResult>>()
    .mockResolvedValue({ status: "changed", validator: "one", data });
  const backend = {
    get version() {
      return signals.version;
    },
    get state() {
      return signals.state;
    },
    subscribe: signals.subscribe.bind(signals),
    subscribeState: signals.subscribeState.bind(signals),
    snapshot,
  };
  const apply = vi.fn();
  return { signals, snapshot, backend, apply };
}
it("subscribes before initial reads and discards data invalidated while in flight", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (value: SnapshotResult) => void;
  f.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startSnapshotView({
    ...f,
    namespaceId: () => "ns",
    activities: [],
    isHidden: () => false,
  });
  f.signals.publish(["snapshot"], ["ns"]);
  finish({ status: "changed", validator: "stale", data });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.apply).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.apply).toHaveBeenCalledOnce();
  stop();
});
it("ignores unrelated namespace invalidations and late results after unsubscribe", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (value: SnapshotResult) => void;
  f.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startSnapshotView({
    ...f,
    namespaceId: () => "ns",
    activities: [],
    isHidden: () => false,
  });
  f.signals.publish(["snapshot"], ["other"]);
  finish({ status: "changed", validator: "one", data });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.apply).toHaveBeenCalledOnce();
  f.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.signals.publish(["snapshot"]);
  stop();
  finish({ status: "changed", validator: "late", data });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.apply).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects superseded generations and waits for ready state before refreshing", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (value: SnapshotResult) => void;
  f.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startSnapshotView({
    ...f,
    namespaceId: () => "ns",
    activities: [],
    isHidden: () => false,
  });
  f.signals.transition({ status: "recovering" });
  f.signals.publish(["snapshot"], undefined, true);
  finish({ status: "changed", validator: "old", data });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.apply).not.toHaveBeenCalled();
  f.signals.transition({ status: "ready" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.apply).toHaveBeenCalledOnce();
  stop();
});

it("reads a static snapshot on visibility wake-up without polling", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let hidden = true;
  let wake!: () => void;
  const release = vi.fn();
  const stop = startSnapshotView({
    ...f,
    namespaceId: () => "ns",
    activities: [],
    retryIntervalMs: false,
    isHidden: () => hidden,
    lifecycle: {
      listen(callback) {
        wake = callback;
        return release;
      },
    },
  });
  expect(f.snapshot).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  hidden = false;
  wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.apply).toHaveBeenCalledOnce();
  stop();
  expect(release).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
