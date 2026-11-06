import { afterEach, expect, it, vi } from "vitest";
import { ActiveClock } from "../../../scripts/restoration-harness/active-clock";
import { trackSuspension } from "../../../scripts/restoration-harness/suspension";
import { validateDeadlineDuration } from "../../../scripts/browser-spike/deadline";
const clocks: ActiveClock[] = [];
afterEach(() => {
  for (const clock of clocks.splice(0)) clock.dispose();
  vi.useRealTimers();
});
function clock(now?: () => number) {
  const instance = new ActiveClock(now);
  clocks.push(instance);
  return instance;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
it("retains a stage's remaining budget across confirmed suspension", async () => {
  vi.useFakeTimers();
  const active = clock(),
    pending = deferred<number>(),
    cleanup = vi.fn();
  const result = active.wait(pending.promise, 100, cleanup);
  const rejected = expect(result).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(40);
  active.suspend("bfcache");
  await vi.advanceTimersByTimeAsync(90_000);
  expect(cleanup).not.toHaveBeenCalled();
  active.resume("bfcache");
  await vi.advanceTimersByTimeAsync(59);
  expect(cleanup).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  await rejected;
  expect(cleanup).toHaveBeenCalledOnce();
});
it("reconciles settled results before an overdue timer on resume", async () => {
  vi.useFakeTimers();
  let now = 0;
  const active = clock(() => now),
    pending = deferred<number>(),
    cleanup = vi.fn();
  const result = active.wait(pending.promise, 500, cleanup);
  now = 10_000;
  active.check();
  pending.resolve(42);
  await vi.advanceTimersByTimeAsync(0);
  expect(await result).toBe(42);
  expect(cleanup).not.toHaveBeenCalled();
});
it("does not publish results or release new dispatch while confirmed suspended", async () => {
  vi.useFakeTimers();
  const active = clock(),
    pending = deferred<number>();
  let settled = false,
    running = false;
  const result = active.wait(pending.promise, 100).then((value) => {
    settled = true;
    return value;
  });
  active.suspend("freeze");
  const gate = active.whenRunning().then(() => {
    running = true;
  });
  pending.resolve(42);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).toBe(false);
  expect(running).toBe(false);
  active.resume("freeze");
  await vi.advanceTimersByTimeAsync(0);
  expect(await result).toBe(42);
  await gate;
  expect(running).toBe(true);
});
it("charges repeated ambiguous gaps until an unresolved stage exhausts its budget", async () => {
  vi.useFakeTimers();
  let now = 0;
  const active = clock(() => now),
    cleanup = vi.fn(),
    resumes = vi.fn();
  active.onResume(resumes);
  const result = active.wait(new Promise(() => {}), 2_500, cleanup);
  const rejected = expect(result).rejects.toThrow("deadline");
  now = 10_000;
  active.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(cleanup).not.toHaveBeenCalled();
  now = 20_000;
  active.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(cleanup).not.toHaveBeenCalled();
  now = 30_000;
  active.check();
  await vi.advanceTimersByTimeAsync(0);
  await rejected;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(resumes).toHaveBeenCalledTimes(2);
});
it("charges each pending deadline once per gap and caps the charge at remaining budget", async () => {
  vi.useFakeTimers();
  let now = 0;
  const active = clock(() => now),
    short = vi.fn(),
    long = vi.fn();
  const a = active.wait(new Promise(() => {}), 500, short),
    b = active.wait(new Promise(() => {}), 5_000, long);
  const failures = Promise.allSettled([a, b]);
  now = 10_000;
  active.check();
  await vi.advanceTimersByTimeAsync(0);
  await failures;
  expect(short).toHaveBeenCalledOnce();
  expect(long).toHaveBeenCalledOnce(); // The exhausted root cancels other work, without replay.
});
it("accounts continuing heartbeats even while visibility is hidden", async () => {
  vi.useFakeTimers();
  const active = clock(),
    cleanup = vi.fn();
  const detach = trackSuspension(active);
  const result = active.wait(new Promise(() => {}), 2_500, cleanup),
    rejected = expect(result).rejects.toThrow("deadline");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  try {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(2_501);
    await rejected;
    expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    detach();
    Reflect.deleteProperty(document, "visibilityState");
  }
});
it("requires matching lifecycle resumes and removes listeners on disposal", async () => {
  vi.useFakeTimers();
  const active = clock();
  Object.defineProperty(document, "onfreeze", { configurable: true, value: null });
  const detach = trackSuspension(active);
  try {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    document.dispatchEvent(new Event("freeze"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(active.paused).toBe(true);
    document.dispatchEvent(new Event("resume"));
    expect(active.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    detach();
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(active.paused).toBe(false);
  } finally {
    detach();
    Reflect.deleteProperty(document, "onfreeze");
  }
});
it("does not interpret ordinary pagehide or a wall-clock adjustment as suspension", async () => {
  vi.useFakeTimers();
  const active = clock(),
    events = vi.fn();
  active.onResume(events);
  const detach = trackSuspension(active);
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  vi.setSystemTime(Date.now() + 86_400_000);
  active.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(active.paused).toBe(false);
  expect(events).not.toHaveBeenCalled();
  detach();
});
it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid test deadline %s before dispatch",
  (duration) => {
    expect(() => validateDeadlineDuration(duration)).toThrow(RangeError);
    const active = clock();
    expect(() => active.wait(Promise.resolve(), duration)).toThrow(RangeError);
  },
);
it("rejects gated work and cancels stage resources once when disposed", async () => {
  vi.useFakeTimers();
  const active = clock(),
    cleanup = vi.fn();
  const result = active.wait(new Promise(() => {}), 100, cleanup);
  const rejected = expect(result).rejects.toThrow("disposed");
  active.suspend("freeze");
  const gate = active.whenRunning(),
    gateRejected = expect(gate).rejects.toThrow("disposed");
  active.dispose();
  active.dispose();
  await rejected;
  await gateRejected;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("reconciles a completed child stage before timing out its awaiting parent", async () => {
  vi.useFakeTimers();
  let now = 0;
  const active = clock(() => now),
    pending = deferred<number>(),
    cleanup = vi.fn();
  const child = active.wait(pending.promise, 500, cleanup);
  const parent = active.wait(
    child.then((value) => value + 1),
    500,
    cleanup,
  );
  const result = expect(Promise.all([child, parent])).resolves.toEqual([41, 42]);
  now = 10_000;
  active.check();
  pending.resolve(41);
  await vi.advanceTimersByTimeAsync(2);
  await result;
  expect(cleanup).not.toHaveBeenCalled();
});
it("does not dispatch while an exhausted budget awaits reconciliation", async () => {
  vi.useFakeTimers();
  let now = 0;
  const active = clock(() => now),
    dispatched = vi.fn();
  const pending = active.wait(new Promise(() => {}), 500);
  const rejected = expect(pending).rejects.toThrow("deadline");
  now = 10_000;
  active.check();
  const gate = active.whenRunning().then(dispatched);
  const gateRejected = expect(gate).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(0);
  await rejected;
  await gateRejected;
  expect(dispatched).not.toHaveBeenCalled();
});
it("never replenishes a partly consumed budget after an ambiguous gap", async () => {
  vi.useFakeTimers();
  let now = 0;
  const active = clock(() => now),
    cleanup = vi.fn();
  const pending = active.wait(new Promise(() => {}), 5_000, cleanup);
  const rejected = expect(pending).rejects.toThrow("deadline");
  for (const time of [1_000, 1_500, 10_000, 11_000, 12_000, 12_999]) {
    now = time;
    active.check();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(cleanup).not.toHaveBeenCalled();
  now = 13_000;
  active.check();
  await vi.advanceTimersByTimeAsync(0);
  await rejected;
  expect(cleanup).toHaveBeenCalledOnce();
});
