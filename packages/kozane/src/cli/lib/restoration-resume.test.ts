import { afterEach, expect, it, vi } from "vitest";
import { ResumeGate } from "../../../../../scripts/restoration-harness/resume-gate";
import { ActiveClock } from "../../../../../scripts/restoration-harness/active-clock";
const clocks: ActiveClock[] = [];
afterEach(() => {
  for (const clock of clocks.splice(0)) clock.dispose();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function drain() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function fixture() {
  const probe = deferred<void>(),
    pending = deferred<void>(),
    connection = deferred<void>(),
    fail = vi.fn();
  const hooks = {
    probe: vi.fn(() => probe.promise),
    pendingDatabase: vi.fn(() => pending.promise),
    connection: vi.fn(() => connection.promise),
    fail,
  };
  const gate = new ResumeGate(hooks);
  return { gate, probe, pending, connection, hooks, fail };
}
it("keeps initialization gates open before any resume and performs no redundant checks", async () => {
  const f = fixture();
  await f.gate.before("initialize");
  f.gate.opened();
  await f.gate.readyForPublication();
  expect(f.hooks.probe).not.toHaveBeenCalled();
  expect(f.gate.canPublish()).toBe(true);
});
it("checks responsiveness without waiting for wasm initialization or a handle", async () => {
  const f = fixture();
  f.gate.resume();
  let ready = false;
  const loader = f.gate.before("initialize").then(() => {
    ready = true;
  });
  await drain();
  expect(ready).toBe(false);
  f.probe.resolve();
  await loader;
  expect(f.hooks.connection).not.toHaveBeenCalled();
  expect(f.hooks.pendingDatabase).not.toHaveBeenCalled();
  f.gate.opened();
  await drain();
  expect(f.hooks.pendingDatabase).toHaveBeenCalledOnce();
  f.pending.resolve();
  await drain();
  expect(f.hooks.connection).toHaveBeenCalledOnce();
  f.connection.resolve();
  await f.gate.readyForPublication();
});
it("reconciles dispatched database replies before checking the connection", async () => {
  const f = fixture();
  f.gate.opened();
  f.gate.resume();
  let permitted = false;
  const next = f.gate.before("run").then(() => {
    permitted = true;
  });
  f.probe.resolve();
  await drain();
  expect(f.hooks.pendingDatabase).toHaveBeenCalledOnce();
  expect(f.hooks.connection).not.toHaveBeenCalled();
  expect(permitted).toBe(false);
  f.pending.resolve();
  await drain();
  expect(f.hooks.connection).toHaveBeenCalledOnce();
  expect(permitted).toBe(false);
  f.connection.resolve();
  await next;
  expect(permitted).toBe(true);
  expect(f.gate.canPublish()).toBe(true);
});
it.each(["probe", "connection"] as const)(
  "rejects dependent work when the %s fails",
  async (stage) => {
    const f = fixture();
    f.gate.opened();
    f.gate.resume();
    const failure = new Error("health check failed");
    const next = f.gate.before("run"),
      rejected = expect(next).rejects.toBe(failure);
    if (stage === "probe") f.probe.reject(failure);
    else {
      f.probe.resolve();
      f.pending.resolve();
      await drain();
      f.connection.reject(failure);
    }
    await rejected;
    expect(f.fail).toHaveBeenCalledOnce();
    expect(() => f.gate.canDispatch("run")).toThrow(failure);
  },
);
it("does not restart a pending probe after another resume", async () => {
  const f = fixture();
  f.gate.resume();
  f.gate.resume();
  f.gate.resume();
  await drain();
  expect(f.hooks.probe).toHaveBeenCalledOnce();
  f.probe.resolve();
  await f.gate.before("initialize");
  expect(f.hooks.probe).toHaveBeenCalledTimes(2);
});
it("sends a fresh responsiveness probe while an earlier connection check remains pending", async () => {
  const f = fixture();
  f.gate.opened();
  f.gate.resume();
  f.probe.resolve();
  f.pending.resolve();
  await drain();
  expect(f.hooks.connection).toHaveBeenCalledOnce();
  const nextProbe = deferred<void>();
  f.hooks.probe.mockImplementation(() => nextProbe.promise);
  f.gate.resume();
  await drain();
  expect(f.hooks.probe).toHaveBeenCalledTimes(2);
  expect(f.hooks.connection).toHaveBeenCalledOnce();
  nextProbe.resolve();
  await drain();
  expect(f.hooks.connection).toHaveBeenCalledOnce();
  f.connection.resolve();
  await f.gate.readyForPublication();
  expect(f.hooks.connection).toHaveBeenCalledTimes(2);
});
it("keeps a still-pending SQL reply on its retained deadline after a healthy probe", async () => {
  vi.useFakeTimers();
  const clock = new ActiveClock();
  clocks.push(clock);
  const sql = deferred<void>(),
    failure = vi.fn(),
    connection = vi.fn(async () => {});
  const retained = clock.wait(sql.promise, 30);
  void retained.catch(() => {});
  const gate = new ResumeGate({
    probe: async () => {},
    pendingDatabase: async () => {
      await Promise.allSettled([retained]);
    },
    connection,
    fail: failure,
  });
  clock.onFailure((error) => {
    failure(error);
    gate.dispose(error);
  });
  gate.opened();
  gate.resume();
  const next = gate.before("run"),
    rejected = expect(next).rejects.toThrow("deadline");
  await drain();
  expect(connection).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(31);
  await rejected;
  expect(connection).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
  sql.resolve();
  await drain();
  expect(connection).not.toHaveBeenCalled();
});
it("repeated ambiguous gaps exhaust a pending health probe without redispatching it", async () => {
  vi.useFakeTimers();
  let now = 0;
  const clock = new ActiveClock(() => now);
  clocks.push(clock);
  const probe = deferred<void>(),
    failure = vi.fn();
  const hooks = {
    probe: vi.fn(() => clock.wait(probe.promise, 2_500)),
    pendingDatabase: async () => {},
    connection: vi.fn(async () => {}),
    fail: failure,
  };
  const gate = new ResumeGate(hooks);
  clock.onResume(() => gate.resume());
  clock.onFailure((error) => {
    failure(error);
    gate.dispose(error);
  });
  gate.opened();
  gate.resume();
  const next = gate.before("run"),
    rejected = expect(next).rejects.toThrow("deadline");
  for (const time of [10_000, 20_000, 30_000]) {
    now = time;
    clock.check();
    await vi.advanceTimersByTimeAsync(0);
  }
  await rejected;
  expect(hooks.probe).toHaveBeenCalledOnce();
  expect(hooks.connection).not.toHaveBeenCalled();
  expect(failure).toHaveBeenCalledOnce();
});
it("repeated resumes cannot renew a stalled connection check", async () => {
  vi.useFakeTimers();
  let now = 0;
  const clock = new ActiveClock(() => now);
  clocks.push(clock);
  const connection = deferred<void>(),
    failure = vi.fn();
  const hooks = {
    probe: vi.fn(async () => {}),
    pendingDatabase: async () => {},
    connection: vi.fn(() => clock.wait(connection.promise, 2_500)),
    fail: failure,
  };
  const gate = new ResumeGate(hooks);
  clock.onResume(() => gate.resume());
  clock.onFailure((error) => {
    failure(error);
    gate.dispose(error);
  });
  gate.opened();
  gate.resume();
  await drain();
  const next = gate.before("run"),
    rejected = expect(next).rejects.toThrow("deadline");
  for (const time of [10_000, 20_000, 30_000]) {
    now = time;
    clock.check();
    await vi.advanceTimersByTimeAsync(0);
  }
  await rejected;
  expect(hooks.connection).toHaveBeenCalledOnce();
  expect(failure).toHaveBeenCalledOnce();
});
it("does not commit, roll back or replay database work during a health check", async () => {
  const f = fixture();
  f.gate.opened();
  f.gate.resume();
  f.probe.resolve();
  f.pending.resolve();
  f.connection.resolve();
  await f.gate.before("run");
  expect(f.hooks.probe).toHaveBeenCalledOnce();
  expect(f.hooks.pendingDatabase).toHaveBeenCalledOnce();
  expect(f.hooks.connection).toHaveBeenCalledOnce();
  expect(f.fail).not.toHaveBeenCalled();
});
it("disposal suppresses late health replies and rejects dependent gates", async () => {
  const f = fixture();
  f.gate.opened();
  f.gate.resume();
  const failure = new Error("worker replaced");
  const next = f.gate.before("run"),
    rejected = expect(next).rejects.toBe(failure);
  f.gate.dispose(failure);
  await rejected;
  f.probe.resolve();
  await drain();
  expect(f.hooks.pendingDatabase).not.toHaveBeenCalled();
  expect(f.hooks.connection).not.toHaveBeenCalled();
  expect(f.fail).not.toHaveBeenCalled();
});
it("does not delete rejected recovery when a publication health check fails", async () => {
  const { restoreCandidate } = await import("../../../../../scripts/restoration-harness/recovery");
  const gate = deferred<void>(),
    entered = deferred<void>(),
    remove = vi.fn();
  let calls = 0;
  const result = restoreCandidate({
    schemaVersion: "current",
    storage: () => ({ getItem: () => "malformed", removeItem: remove }),
    sample: async () => ({ bytes: new Uint8Array([1]), namespaceId: "sample" }),
    open: async () => ({ validate: async () => "view", close: async () => {} }),
    publication: {
      ready: async () => {
        if (++calls === 2) {
          entered.resolve();
          await gate.promise;
        }
      },
      isReady: () => true,
    },
  });
  await entered.promise;
  expect(remove).not.toHaveBeenCalled();
  gate.reject(new Error("resume connection failed"));
  expect(await result).toMatchObject({ status: "unavailable", action: "retry", kind: "unknown" });
  expect(remove).not.toHaveBeenCalled();
});
it("revalidates on a late publication race without reopening the candidate", async () => {
  const { restoreCandidate } = await import("../../../../../scripts/restoration-harness/recovery");
  let calls = 0,
    reads = 0,
    healthy = true,
    opens = 0;
  const remove = vi.fn();
  const result = await restoreCandidate({
    schemaVersion: "current",
    storage: () => ({ getItem: () => "malformed", removeItem: remove }),
    sample: async () => ({ bytes: new Uint8Array([1]), namespaceId: "sample" }),
    open: async () => {
      opens++;
      return { validate: async () => ++reads, close: async () => {} };
    },
    publication: {
      ready: async () => {
        healthy = ++calls !== 2;
      },
      isReady: () => healthy,
    },
  });
  expect(result).toMatchObject({ status: "ready", view: 3 });
  expect(opens).toBe(2);
  expect(remove).toHaveBeenCalledOnce();
  if (result.status === "ready") await result.candidate.close();
});
