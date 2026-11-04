import { expect, it, vi } from "vitest";
import { BackendSignals } from "./signals";
import { BackendError } from "./contract";
it("delivers lifecycle state immediately and independently from data", () => {
  const signals = new BackendSignals({ status: "initializing" });
  const state = vi.fn(),
    data = vi.fn();
  const unsubscribe = signals.subscribeState(state);
  signals.subscribe(data);
  expect(state).toHaveBeenCalledWith({ status: "initializing" });
  signals.transition({
    status: "unavailable",
    error: new BackendError("unavailable", "Worker failed"),
    recovery: "retry",
  });
  expect(state).toHaveBeenCalledTimes(2);
  expect(data).not.toHaveBeenCalled();
  unsubscribe();
  signals.transition({ status: "recovering" });
  expect(state).toHaveBeenCalledTimes(2);
});
it("updates immutable stamps before notifying and reserves no public reset generation", () => {
  const signals = new BackendSignals({ status: "ready" });
  const old = signals.version;
  signals.subscribe((event) => {
    expect(signals.version).toEqual({ generation: event.generation, revision: event.revision });
    expect(Object.isFrozen(event.datasets)).toBe(true);
  });
  signals.publish(["snapshot", "tags"], ["ns"]);
  expect(old).toEqual({ generation: 0, revision: 0 });
  expect(Object.isFrozen(old)).toBe(true);
  signals.publish(["map"], undefined, true);
  expect(signals.version).toEqual({ generation: 1, revision: 0 });
});
it("rejects empty targets before changing stamps and stops publications after disposal", () => {
  const signals = new BackendSignals({ status: "ready" });
  const listener = vi.fn();
  signals.subscribe(listener);
  expect(() => signals.publish(["snapshot"], [])).toThrow(BackendError);
  expect(signals.version.revision).toBe(0);
  signals.dispose();
  signals.dispose();
  signals.subscribeState(listener);
  expect(listener).not.toHaveBeenCalled();
  expect(() => signals.publish(["map"])).toThrow("disposed");
});
it("isolates listener failures from later subscribers and committed publications", () => {
  const onError = vi.fn(),
    later = vi.fn();
  const signals = new BackendSignals({ status: "ready" }, onError);
  signals.subscribe(() => {
    throw new Error("subscriber");
  });
  signals.subscribe(later);
  signals.publish(["namespaces"]);
  expect(onError).toHaveBeenCalledOnce();
  expect(later).toHaveBeenCalledOnce();
  expect(signals.version.revision).toBe(1);
});
