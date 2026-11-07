import { describe, expect, it } from "vitest";
import { OperationQueue } from "../../src/backend/operation-queue.js";

describe("whole-operation queue", () => {
  it("keeps reads and exports behind a complete multi-query write", async () => {
    const queue = new OperationQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = queue.run(async () => {
      events.push("begin", "first query");
      await gate;
      events.push("second query", "commit");
    });
    const read = queue.run(async () => {
      events.push("read");
    });
    const exported = queue.run(async () => {
      events.push("export");
    });
    await Promise.resolve();
    expect(events).toEqual(["begin", "first query"]);
    release();
    await Promise.all([write, read, exported]);
    expect(events).toEqual(["begin", "first query", "second query", "commit", "read", "export"]);
  });

  it("waits for rollback and permits later work after rejection", async () => {
    const queue = new OperationQueue();
    const events: string[] = [];
    const failed = queue.run(async () => {
      try {
        throw new Error("mutation failed");
      } finally {
        await Promise.resolve();
        events.push("rollback");
      }
    });
    const next = queue.run(async () => {
      events.push("read");
      return 42;
    });
    await expect(failed).rejects.toThrow("mutation failed");
    await expect(next).resolves.toBe(42);
    expect(events).toEqual(["rollback", "read"]);
  });

  it("rejects queued and future work on idempotent disposal", async () => {
    const queue = new OperationQueue();
    let called = false;
    const pending = queue.run(async () => {
      called = true;
    });
    queue.dispose();
    queue.dispose();
    await expect(pending).rejects.toThrow("disposed");
    await expect(queue.run(async () => 1)).rejects.toThrow("disposed");
    expect(called).toBe(false);
  });
});
