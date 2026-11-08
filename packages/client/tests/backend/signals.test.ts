import { expect, it, vi } from "vitest";
import { ClientSignals } from "../../src/backend/signals.js";
import { ClientError } from "../../src/backend/contract.js";
it("delivers lifecycle state immediately and independently from data", () => {
  const signals = new ClientSignals({ status: "initializing" });
  const state = vi.fn(),
    data = vi.fn();
  const unsubscribe = signals.subscribeState(state);
  signals.subscribe(data);
  expect(state).toHaveBeenCalledWith({ status: "initializing" });
  signals.transition({
    status: "unavailable",
    error: new ClientError("unavailable", "Worker failed"),
    recovery: "retry",
  });
  expect(state).toHaveBeenCalledTimes(2);
  expect(data).not.toHaveBeenCalled();
  unsubscribe();
  signals.transition({ status: "recovering" });
  expect(state).toHaveBeenCalledTimes(2);
});
it("updates immutable stamps before notifying and reserves no public reset generation", () => {
  const signals = new ClientSignals({ status: "ready" });
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
  const signals = new ClientSignals({ status: "ready" });
  const listener = vi.fn();
  signals.subscribe(listener);
  expect(() => signals.publish(["snapshot"], [])).toThrow(ClientError);
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
  const signals = new ClientSignals({ status: "ready" }, onError);
  signals.subscribe(() => {
    throw new Error("subscriber");
  });
  signals.subscribe(later);
  signals.publish(["namespaces"]);
  expect(onError).toHaveBeenCalledOnce();
  expect(later).toHaveBeenCalledOnce();
  expect(signals.version.revision).toBe(1);
});

it("copies and freezes namespace-scoped targets independently of caller-owned arrays", () => {
  const signals = new ClientSignals({ status: "ready" });
  const datasets = ["snapshot", "tags"] as ("snapshot" | "tags")[];
  const namespaces = ["one"];
  const events: unknown[] = [];
  signals.subscribe((event) => events.push(event));
  const event = signals.publish(datasets, namespaces);
  datasets.pop();
  namespaces.push("two");
  expect(event).toEqual({
    generation: 0,
    revision: 1,
    datasets: ["snapshot", "tags"],
    namespaceIds: ["one"],
  });
  expect(Object.isFrozen(event)).toBe(true);
  expect(Object.isFrozen(event.namespaceIds)).toBe(true);
  expect(Object.isFrozen(event.datasets)).toBe(true);
  signals.publish(["map"]);
  expect(events[0]).toBe(event);
  expect(event.revision).toBe(1);
  expect(signals.version.revision).toBe(2);
});
