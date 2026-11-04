import { expect, it } from "vitest";
import { createTestDB } from "../test-utils/db.js";
import { createNamespace } from "../db/api/namespace.js";
import { getDefaultPartition } from "../db/api/partition.js";
import { cardTable } from "../db/schema.js";
import { createServiceContext } from "./context.js";
import { create } from "./cards.js";
import { ValidationError } from "./errors.js";

it("enforces configured content limits and canvas bounds without HTTP", async () => {
  const db = await createTestDB();
  const namespaceId = await createNamespace({ db, name: "Service fixture" });
  const partition = await getDefaultPartition({ db, namespaceId });
  const context = createServiceContext({ contentMax: 100, canvasWidth: 400, canvasHeight: 500 });
  const card = await create(db, context, namespaceId, {
    partitionId: partition!.id,
    content: "x".repeat(100),
    posX: 999,
    posY: -12,
  });
  expect(card.content).toHaveLength(100);
  expect(card.posX).toBe(400);
  expect(card.posY).toBe(0);
  await expect(
    create(db, context, namespaceId, {
      partitionId: partition!.id,
      content: "x".repeat(101),
    }),
  ).rejects.toThrow(ValidationError);
  expect(await db.select().from(cardTable)).toHaveLength(1);
});

it("rolls back card creation when inventory placement fails", async () => {
  const db = await createTestDB();
  const namespaceId = await createNamespace({ db, name: "Rollback fixture" });
  const partition = await getDefaultPartition({ db, namespaceId });
  await expect(
    create(db, createServiceContext(), namespaceId, {
      partitionId: partition!.id,
      content: "must roll back",
      inventoryId: "missing",
    }),
  ).rejects.toThrow("Inventory not found in namespace");
  expect(await db.select().from(cardTable)).toHaveLength(0);
});
