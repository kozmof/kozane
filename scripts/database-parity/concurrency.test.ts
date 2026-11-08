import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB, exportTestDB } from "./driver.js";
import { withTx, withReadTx } from "@kozane/core/database";
import { OperationQueue } from "../../packages/client/src/client/operation-queue.js";

it("queues complete multi-query writes, snapshot reads and failed rollbacks", async () => {
  const db = await createTestDB();
  const queue = new OperationQueue();
  await db.run(sql`create table parity_write (id integer primary key)`);
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const first = queue.run(() =>
    withTx(db, async (tx) => {
      await tx.run(sql`insert into parity_write values (1)`);
      started();
      await held;
      await tx.run(sql`insert into parity_write values (2)`);
    }),
  );
  await entered;
  let observed = false;
  const snapshot = queue.run(() =>
    withReadTx(db, async (tx) => {
      observed = true;
      return tx.values(sql`select id from parity_write order by id`);
    }),
  );
  const exported = queue.run(() => exportTestDB(db));
  const failed = queue.run(() =>
    withTx(db, async (tx) => {
      await tx.run(sql`insert into parity_write values (3)`);
      throw new Error("rollback parity write");
    }),
  );
  const failure = expect(failed).rejects.toThrow("rollback parity write");
  const final = queue.run(() =>
    withReadTx(db, (tx) => tx.values(sql`select id from parity_write order by id`)),
  );
  expect(observed).toBe(false);
  resume();
  await first;
  expect(await snapshot).toEqual([[1], [2]]);
  expect(new TextDecoder().decode((await exported).slice(0, 15))).toBe("SQLite format 3");
  await failure;
  expect(await final).toEqual([[1], [2]]);
  queue.dispose();
});
