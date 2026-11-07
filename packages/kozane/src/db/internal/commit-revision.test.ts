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

import { composeWrite } from "../database.js";
import { createServiceContext } from "../../services/context.js";
import * as namespaces from "../../services/namespaces.js";
import { createInTx } from "../../services/cards.js";
import { cardTable, layerTable, partitionTable } from "../schema.js";

it("counts namespace initialization and composed service writes once per outer commit", async () => {
  const db = await createTestDB();
  const context = createServiceContext();
  const before = nodeCommitRevision(db).revision;
  const namespace = await namespaces.create(db, context, { name: "Initialized" });
  expect(nodeCommitRevision(db).revision).toBe(before + 1);
  expect(await db.select().from(layerTable)).toHaveLength(1);
  const [partition] = await db.select().from(partitionTable);
  const created = await composeWrite(db, async (tx) => {
    const one = await createInTx(tx, context, namespace.id, {
      partitionId: partition.id,
      content: "One",
    });
    const two = await createInTx(tx, context, namespace.id, {
      partitionId: partition.id,
      content: "Two",
    });
    expect(nodeCommitRevision(db).revision).toBe(before + 1);
    return [one, two];
  });
  expect(created).toHaveLength(2);
  expect(await db.select().from(cardTable)).toHaveLength(2);
  expect(nodeCommitRevision(db).revision).toBe(before + 2);
});
it("keeps the revision unchanged when a composed service write rolls back", async () => {
  const db = await createTestDB();
  const context = createServiceContext();
  const namespace = await namespaces.create(db, context, { name: "Rollback" });
  const [partition] = await db.select().from(partitionTable);
  const before = nodeCommitRevision(db);
  await expect(
    composeWrite(db, async (tx) => {
      await createInTx(tx, context, namespace.id, {
        partitionId: partition.id,
        content: "Uncommitted",
      });
      await createInTx(tx, context, namespace.id, { partitionId: "missing", content: "Refused" });
    }),
  ).rejects.toThrow("Partition not found in namespace");
  expect(nodeCommitRevision(db)).toEqual(before);
  expect(await db.select().from(cardTable)).toEqual([]);
});
