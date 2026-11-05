import { expect, it } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { nodeCommitRevision, withTx, withReadTx } from "../tx.js";
import { namespaceTable } from "../schema.js";
it("advances once per outer commit and for standalone writes, preserving read/rollback stamps", async () => {
  const db = await createTestDB();
  const initial = nodeCommitRevision(db);
  await withReadTx(db, (tx) => tx.select().from(namespaceTable));
  expect(nodeCommitRevision(db)).toEqual(initial);
  await withTx(db, async (tx) => {
    await tx.insert(namespaceTable).values({ name: "one" });
    await tx.insert(namespaceTable).values({ name: "two" });
  });
  expect(nodeCommitRevision(db).revision).toBe(initial.revision + 1);
  const committed = nodeCommitRevision(db);
  await expect(
    withTx(db, async (tx) => {
      await tx.insert(namespaceTable).values({ name: "rollback" });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(nodeCommitRevision(db)).toEqual(committed);
  await db.insert(namespaceTable).values({ name: "standalone" });
  expect(nodeCommitRevision(db).revision).toBe(committed.revision + 1);
});
