import { afterEach, expect, it, vi } from "vitest";
import { BackendSignals } from "./signals.js";
import { startDatasetView } from "./dataset-view.js";
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
