import { afterEach, expect, it, vi } from "vitest";
import { BackendSignals } from "../../src/backend/signals.js";
import { startDatasetView } from "../../src/backend/dataset-view.js";
afterEach(() => vi.useRealTimers());
function fixture() {
  const signals = new BackendSignals({ status: "ready" });
  const backend = {
    get version() {
      return signals.version;
    },
    get state() {
      return signals.state;
    },
    subscribe: signals.subscribe.bind(signals),
    subscribeState: signals.subscribeState.bind(signals),
  };
  const read = vi.fn<() => Promise<string>>().mockResolvedValue("current");
  const apply = vi.fn();
  return { signals, backend, read, apply };
}
it("subscribes before reading and coalesces invalidations that supersede a running read", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (value: string) => void;
  f.read.mockImplementationOnce(() => {
    f.signals.publish(["map"]);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const stop = startDatasetView({ ...f, dataset: "map", isHidden: () => false });
  f.signals.publish(["map"]);
  f.signals.publish(["tags"]);
  finish("stale");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.apply).toHaveBeenCalledExactlyOnceWith("current");
  expect(f.read).toHaveBeenCalledTimes(2);
  stop();
  f.signals.publish(["map"]);
  expect(vi.getTimerCount()).toBe(0);
});
it("waits for visibility and ready state, rejects old-generation results, and retries failures", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let hidden = true;
  const stop = startDatasetView({ ...f, dataset: "tags", isHidden: () => hidden });
  expect(f.read).not.toHaveBeenCalled();
  let finish!: (value: string) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  hidden = false;
  await vi.advanceTimersByTimeAsync(1000);
  f.signals.transition({ status: "recovering" });
  f.signals.publish(["tags"], undefined, true);
  finish("old generation");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.apply).not.toHaveBeenCalled();
  f.read.mockRejectedValueOnce(new Error("offline"));
  f.signals.transition({ status: "ready" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.apply).toHaveBeenCalledExactlyOnceWith("current");
  stop();
});
it("rejects late results after a selected view is replaced", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (value: string) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startDatasetView({ ...f, dataset: "map", isHidden: () => false });
  stop();
  const stopNext = startDatasetView({ ...f, dataset: "map", isHidden: () => false });
  await vi.advanceTimersByTimeAsync(0);
  finish("previous selection");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.apply).toHaveBeenCalledExactlyOnceWith("current");
  stopNext();
});

it("reports only current view failures and rejects error callbacks after disposal", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const error = vi.fn();
  f.read.mockRejectedValueOnce(new Error("offline"));
  const stop = startDatasetView({ ...f, dataset: "tags", isHidden: () => false, error });
  await vi.advanceTimersByTimeAsync(0);
  expect(error).toHaveBeenCalledOnce();
  let reject!: (error: unknown) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  stop();
  reject(new Error("late failure"));
  await vi.advanceTimersByTimeAsync(0);
  expect(error).toHaveBeenCalledOnce();
});

it("reads static data after a visibility wake-up without starting a retry timer", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let hidden = true;
  let wake!: () => void;
  const release = vi.fn();
  const stop = startDatasetView({
    ...f,
    dataset: "tags",
    retryIntervalMs: false,
    isHidden: () => hidden,
    lifecycle: {
      listen(callback) {
        wake = callback;
        return release;
      },
    },
  });
  expect(f.read).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  hidden = false;
  wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.apply).toHaveBeenCalledExactlyOnceWith("current");
  stop();
  expect(release).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("lets incremental readers reject superseded and disposed work", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const guards: (() => boolean)[] = [];
  let finish!: (value: string) => void;
  const read = vi.fn((isCurrent: () => boolean) => {
    guards.push(isCurrent);
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const stop = startDatasetView({ ...f, read, dataset: "tags", isHidden: () => false });
  expect(guards[0]()).toBe(true);
  f.signals.publish(["map"]);
  expect(guards[0]()).toBe(true);
  f.signals.publish(["tags"]);
  expect(guards[0]()).toBe(false);
  finish("stale");
  await vi.advanceTimersByTimeAsync(1000);
  expect(guards[1]()).toBe(true);
  stop();
  expect(guards[1]()).toBe(false);
  finish("disposed");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.apply).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
