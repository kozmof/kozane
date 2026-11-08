import { expect, it, vi } from "vitest";
import {
  AttemptOwner,
  SupersededAttemptError,
} from "../../../../../scripts/restoration-harness/attempt";
import {
  restoreCandidate,
  HarnessFailure,
  type RestoreOptions,
} from "../../../../../scripts/restoration-harness/recovery";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const owner = new AttemptOwner();
  let saved = "malformed",
    opens = 0;
  const remove = vi.fn(() => {
    saved = "deleted";
  });
  const closed: number[] = [];
  const options: RestoreOptions<string> = {
    schemaVersion: "current",
    attempt: owner.begin(),
    storage: () => ({ getItem: () => saved, removeItem: remove }),
    sample: async () => ({ bytes: new Uint8Array([1]), namespaceId: "sample" }),
    open: async () => {
      const id = ++opens;
      return {
        validate: async () => "view",
        close: async () => {
          closed.push(id);
        },
      };
    },
  };
  return {
    owner,
    options,
    remove,
    closed,
    save: (value: string) => {
      saved = value;
    },
    saved: () => saved,
    opens: () => opens,
  };
}
it("invalidates startup tickets independently of destination changes", () => {
  const owner = new AttemptOwner(),
    old = owner.begin();
  const listener = vi.fn();
  old.onSuperseded(listener);
  const latest = owner.begin();
  expect(old.isCurrent()).toBe(false);
  expect(() => old.assertCurrent()).toThrow(SupersededAttemptError);
  expect(latest.isCurrent()).toBe(true);
  expect(listener).toHaveBeenCalledOnce();
  owner.replaceGeneration();
  expect(latest.isCurrent()).toBe(false);
  const next = owner.begin();
  expect(next.generation).toBe(1);
  expect(next.attempt).toBeGreaterThan(latest.attempt);
});
it("retains the newest lease when a cleanup observer starts another attempt", () => {
  const owner = new AttemptOwner(),
    old = owner.begin();
  let nested: ReturnType<typeof owner.begin> | undefined;
  old.onSuperseded(() => {
    nested = owner.begin();
  });
  const outer = owner.begin();
  expect(outer.isCurrent()).toBe(false);
  expect(nested!.isCurrent()).toBe(true);
});
it("isolates cleanup failures and supports observer removal", () => {
  const owner = new AttemptOwner(),
    old = owner.begin(),
    called = vi.fn();
  const unsubscribe = old.onSuperseded(called);
  unsubscribe();
  old.onSuperseded(() => {
    throw new Error("cleanup failed");
  });
  const latest = owner.begin();
  expect(latest.isCurrent()).toBe(true);
  expect(called).not.toHaveBeenCalled();
  expect(() =>
    old.onSuperseded(() => {
      throw new Error("late cleanup");
    }),
  ).not.toThrow();
});
it("does no storage or database work for an already obsolete lease", async () => {
  const f = fixture();
  f.owner.begin();
  const storage = vi.fn(f.options.storage);
  f.options.storage = storage;
  expect(await restoreCandidate(f.options)).toEqual({ status: "superseded" });
  expect(storage).not.toHaveBeenCalled();
  expect(f.opens()).toBe(0);
});
it.each(["attempt", "generation"] as const)(
  "closes a candidate whose open resolves after %s replacement",
  async (replacement) => {
    const f = fixture(),
      gate = deferred<void>(),
      entered = deferred<void>(),
      validate = vi.fn(async () => "view"),
      close = vi.fn(async () => {});
    f.options.open = async () => {
      entered.resolve();
      await gate.promise;
      return { validate, close };
    };
    const pending = restoreCandidate(f.options);
    await entered.promise;
    if (replacement === "attempt") f.owner.begin();
    else f.owner.replaceGeneration();
    f.save("newer saved copy");
    gate.resolve();
    expect(await pending).toEqual({ status: "superseded" });
    expect(validate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.saved()).toBe("newer saved copy");
  },
);
it.each([false, true])("suppresses a late fallback view outcome (failure %s)", async (fails) => {
  const f = fixture(),
    gate = deferred<void>(),
    entered = deferred<void>();
  const open = f.options.open;
  let calls = 0;
  f.options.open = async (bytes) => {
    const candidate = await open(bytes);
    if (++calls === 2)
      candidate.validate = async () => {
        entered.resolve();
        await gate.promise;
        if (fails) throw new HarnessFailure("database_content", "obsolete defect");
        return "obsolete view";
      };
    return candidate;
  };
  const pending = restoreCandidate(f.options);
  await entered.promise;
  f.owner.begin();
  f.save("newer saved copy");
  gate.resolve();
  expect(await pending).toEqual({ status: "superseded" });
  expect(f.closed).toEqual([1, 2]);
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.saved()).toBe("newer saved copy");
});
it("does not open a fallback after an obsolete restored-content failure", async () => {
  const f = fixture();
  f.save(JSON.stringify({ schemaVersion: "current", savedAt: 0, db: "AA==" }));
  const gate = deferred<void>(),
    entered = deferred<void>();
  const open = f.options.open;
  let calls = 0;
  f.options.open = async (bytes) => {
    const candidate = await open(bytes);
    if (++calls === 2)
      candidate.validate = async () => {
        entered.resolve();
        await gate.promise;
        throw new HarnessFailure("database_content", "old restored defect");
      };
    return candidate;
  };
  const pending = restoreCandidate(f.options);
  await entered.promise;
  f.owner.replaceGeneration();
  gate.resolve();
  expect(await pending).toEqual({ status: "superseded" });
  expect(f.opens()).toBe(2);
  expect(f.remove).not.toHaveBeenCalled();
});
it("ignores obsolete sample asset failures while preserving recovery", async () => {
  const f = fixture(),
    gate = deferred<void>(),
    entered = deferred<void>();
  f.options.sample = async () => {
    entered.resolve();
    await gate.promise;
    throw new HarnessFailure("asset", "old build failure");
  };
  const pending = restoreCandidate(f.options);
  await entered.promise;
  f.owner.begin();
  gate.resolve();
  expect(await pending).toEqual({ status: "superseded" });
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.opens()).toBe(0);
});
it("lets the current lease reach readiness and delete only its rejected copy", async () => {
  const f = fixture();
  const result = await restoreCandidate(f.options);
  expect(result).toMatchObject({ status: "ready", source: "sample" });
  expect(f.remove).toHaveBeenCalledOnce();
  if (result.status === "ready") await result.candidate.close();
  expect(f.closed).toEqual([1, 2]);
});
