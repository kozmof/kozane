import { expect, it, vi } from "vitest";
import type { Client, Transaction } from "@libsql/client";
import { commitRevision, trackedClient } from "./commit-revision.js";
function fixture() {
  const tx = {
    execute: vi.fn().mockResolvedValue({}),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
  const driver = {
    execute: vi.fn().mockResolvedValue({}),
    batch: vi.fn().mockResolvedValue([]),
    migrate: vi.fn().mockResolvedValue([]),
    transaction: vi.fn().mockResolvedValue(tx as unknown as Transaction),
  };
  const state = commitRevision();
  return { state, tx, driver, client: trackedClient(driver as unknown as Client, state) };
}
it("counts successful standalone writes after dispatch and excludes reads and failures", async () => {
  const f = fixture();
  for (const statement of [
    "SELECT 1",
    "-- comment\n SELECT 1",
    "/* comment */ PRAGMA table_info(t)",
    "EXPLAIN SELECT 1",
    "VALUES (1)",
  ])
    await f.client.execute(statement);
  expect(f.state.revision).toBe(0);
  let finish!: (result: object) => void;
  f.driver.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.client.execute({
    sql: "/* comment */ -- next\n INSERT INTO t VALUES (?)",
    args: ["private"],
  });
  expect(f.state.revision).toBe(0);
  finish({});
  await pending;
  expect(f.state.revision).toBe(1);
  f.driver.execute.mockRejectedValueOnce(new Error("write failed"));
  await expect(f.client.execute("DELETE FROM t")).rejects.toThrow("write failed");
  expect(f.state.revision).toBe(1);
});
it.each(["batch", "migrate"] as const)(
  "counts a committed %s once and excludes failed and read-only batches",
  async (method) => {
    const f = fixture();
    await f.client[method](["SELECT 1", "PRAGMA table_info(t)"]);
    expect(f.state.revision).toBe(0);
    await f.client[method](["INSERT INTO t VALUES (1)", "UPDATE t SET v=2", "SELECT 1"]);
    expect(f.state.revision).toBe(1);
    f.driver[method].mockRejectedValueOnce(new Error("batch rolled back"));
    await expect(f.client[method](["INSERT INTO t VALUES (3)"])).rejects.toThrow(
      "batch rolled back",
    );
    expect(f.state.revision).toBe(1);
  },
);
it("advances only after a successful outer write commit and before its caller resumes", async () => {
  const f = fixture();
  const tx = await f.client.transaction("write");
  await tx.execute("INSERT INTO t VALUES (1)");
  await tx.execute("INSERT INTO t VALUES (2)");
  expect(f.state.revision).toBe(0);
  let finish!: () => void;
  f.tx.commit.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = tx.commit().then(() => expect(f.state.revision).toBe(1));
  expect(f.state.revision).toBe(0);
  finish();
  await pending;
  await tx.commit();
  expect(f.state.revision).toBe(1);
});
it("does not advance when commit fails or an uncommitted transaction rolls back or closes", async () => {
  const f = fixture();
  const tx = await f.client.transaction("write");
  await tx.execute("INSERT INTO t VALUES (1)");
  f.tx.commit.mockRejectedValueOnce(new Error("commit failed"));
  await expect(tx.commit()).rejects.toThrow("commit failed");
  await tx.rollback();
  tx.close();
  expect(f.state.revision).toBe(0);
});
it.each(["read", "deferred"] as const)(
  "preserves stamps for committed %s transactions",
  async (mode) => {
    const f = fixture();
    const tx = await f.client.transaction(mode);
    await tx.execute("SELECT 1");
    await tx.commit();
    expect(f.state.revision).toBe(0);
  },
);
