import { expect, it, vi } from "vitest";
import { DestinationTracker } from "../../../scripts/restoration-harness/navigation";
import { ResetSession, type ResetOptions } from "../../../scripts/restoration-harness/reset";
import { HarnessFailure, restoreCandidate } from "../../../scripts/restoration-harness/recovery";
import { OperationQueue } from "../../lib/backend/operation-queue";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each([false, true])(
  "discards a superseded view result or failure (failure %s)",
  async (fails) => {
    const navigation = new DestinationTracker("old");
    const gate = deferred<void>();
    const read = vi.fn(async (id?: string) => {
      if (id === "old") {
        await gate.promise;
        if (fails) throw new HarnessFailure("database_content", "obsolete view defect");
        return "old view";
      }
      return id;
    });
    const result = navigation.resolve(read);
    navigation.select("new");
    gate.resolve();
    expect(await result).toBe("new");
    expect(read.mock.calls.map((call) => call[0])).toEqual(["old", "new"]);
  },
);
it("keeps the sequence monotonic when navigating away and back", () => {
  const navigation = new DestinationTracker("same");
  const ticket = navigation.capture();
  navigation.select("other");
  navigation.select("same");
  expect(navigation.isCurrent(ticket)).toBe(false);
});
it("current view failures retain their classification", async () => {
  const failure = new HarnessFailure("unknown", "read failed");
  await expect(
    new DestinationTracker().resolve(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});
it("rechecks a destination changed just after validation before deleting recovery", async () => {
  const navigation = new DestinationTracker("old");
  const events: string[] = [];
  let reads = 0;
  const result = await restoreCandidate({
    schemaVersion: "current",
    navigation,
    storage: () => ({ getItem: () => "invalid", removeItem: () => events.push("delete") }),
    sample: async () => ({ bytes: new Uint8Array([1]), namespaceId: "sample" }),
    open: async () => ({
      validate: async () => {
        reads++;
        events.push(navigation.capture().namespaceId!);
        if (reads === 2) navigation.select("latest");
        return navigation.capture().namespaceId;
      },
      close: async () => {},
    }),
  });
  expect(result).toMatchObject({ status: "ready", view: "latest" });
  expect(events).toEqual(["old", "old", "latest", "delete"]);
});
function fixture() {
  const events: string[] = [];
  const queue = new OperationQueue();
  const original = {
    validate: async () => "original",
    close: vi.fn(async () => {
      events.push("old closed");
    }),
  };
  const session = new ResetSession(
    {
      generation: 3,
      candidate: original,
      view: "original",
      namespaceId: "user",
      url: "/tags/?namespaceId=user#tag=private",
    },
    (operation) => queue.run(operation),
  );
  const staged = { validate: vi.fn(async () => "sample"), close: vi.fn(async () => {}) };
  const storage = {
    getItem: () => "saved",
    removeItem: vi.fn(() => {
      events.push("delete");
    }),
  };
  const options: ResetOptions<string> = {
    sample: async () => ({ bytes: new Uint8Array([1]), namespaceId: "sample" }),
    open: async () => staged,
    storage: () => storage,
    destination: (id) => `/board/?namespaceId=${id}`,
  };
  return { events, queue, original, session, staged, storage, options };
}
it("serializes reset after earlier operations and activates validated data before deletion", async () => {
  const f = fixture(),
    gate = deferred<void>();
  const earlier = f.queue.run(async () => {
    await gate.promise;
    f.events.push("earlier finished");
  });
  const reset = f.session.reset(f.options);
  expect(f.session.state.generation).toBe(3);
  expect(f.staged.validate).not.toHaveBeenCalled();
  f.storage.removeItem.mockImplementation(() => {
    expect(f.session.state.generation).toBe(4);
    f.events.push("delete");
  });
  gate.resolve();
  await earlier;
  expect(await reset).toMatchObject({
    status: "ready",
    state: {
      generation: 4,
      namespaceId: "sample",
      url: "/board/?namespaceId=sample",
      view: "sample",
    },
  });
  expect(f.staged.validate).toHaveBeenCalledWith({
    namespaceId: "sample",
    sampleNamespaceId: "sample",
  });
  expect(f.events).toEqual(["earlier finished", "delete", "old closed"]);
});
it.each(["database_content", "asset", "transient", "unknown"] as const)(
  "preserves state, URL and storage after reset %s failure",
  async (kind) => {
    const f = fixture();
    const before = f.session.state;
    f.staged.validate.mockRejectedValue(new HarnessFailure(kind, "injected"));
    expect(await f.session.reset(f.options)).toMatchObject({
      status: "unavailable",
      action: kind === "asset" || kind === "database_content" ? "reload" : "retry",
      kind,
    });
    expect(f.session.state).toBe(before);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(f.original.close).not.toHaveBeenCalled();
    expect(f.staged.close).toHaveBeenCalledOnce();
    if (kind === "asset" || kind === "database_content") {
      f.staged.validate.mockResolvedValue("sample");
      await f.session.reset(f.options);
      expect(f.staged.validate).toHaveBeenCalledOnce();
    }
  },
);
it("preserves the URL when destination construction fails", async () => {
  const f = fixture();
  f.options.destination = () => {
    throw new Error("navigation adapter failed");
  };
  expect(await f.session.reset(f.options)).toMatchObject({
    status: "unavailable",
    action: "retry",
  });
  expect(f.session.state.url).toContain("#tag=private");
  expect(f.storage.removeItem).not.toHaveBeenCalled();
  expect(f.staged.close).toHaveBeenCalledOnce();
});
it("continues with accurate recovery status when deletion fails", async () => {
  const f = fixture();
  f.storage.removeItem.mockImplementation(() => {
    throw new Error("SecurityError");
  });
  expect(await f.session.reset(f.options)).toMatchObject({
    status: "ready",
    olderCopyMayRestore: true,
    recoveryUnavailable: true,
  });
  expect(f.session.state.url).toBe("/board/?namespaceId=sample");
});
it("treats failed staged cleanup as uncertainty and permits an explicit retry", async () => {
  const f = fixture();
  f.staged.validate.mockRejectedValue(new HarnessFailure("database_content", "bad sample"));
  f.staged.close.mockRejectedValue(new Error("cleanup failed"));
  expect(await f.session.reset(f.options)).toMatchObject({
    status: "unavailable",
    action: "retry",
    kind: "unknown",
  });
  expect(f.session.state.generation).toBe(3);
  expect(f.storage.removeItem).not.toHaveBeenCalled();
});

it("reports old-handle cleanup separately from storage failure after activation", async () => {
  const f = fixture();
  f.original.close.mockRejectedValue(new Error("old handle failed to close"));
  expect(await f.session.reset(f.options)).toMatchObject({
    status: "ready",
    previousCleanupFailed: true,
    recoveryUnavailable: false,
    olderCopyMayRestore: false,
  });
  expect(f.session.state.generation).toBe(4);
});
it("keeps the old generation and copy when browser navigation rejects the reset destination", async () => {
  const f = fixture();
  f.options.navigate = () => {
    throw new Error("replaceState failed");
  };
  expect(await f.session.reset(f.options)).toMatchObject({
    status: "unavailable",
    action: "retry",
  });
  expect(f.session.state.generation).toBe(3);
  expect(f.storage.removeItem).not.toHaveBeenCalled();
  expect(f.original.close).not.toHaveBeenCalled();
  expect(f.staged.close).toHaveBeenCalledOnce();
});
it("applies navigation inside the barrier before queued reads see the new state", async () => {
  const f = fixture();
  f.options.navigate = (url) => {
    f.events.push(url);
  };
  const resetting = f.session.reset(f.options);
  const reading = f.queue.run(async () => ({
    generation: f.session.state.generation,
    url: f.session.state.url,
  }));
  await resetting;
  expect(await reading).toEqual({ generation: 4, url: "/board/?namespaceId=sample" });
  expect(f.events).toEqual(["/board/?namespaceId=sample", "delete", "old closed"]);
});
