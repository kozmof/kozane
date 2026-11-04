import { expect, it } from "vitest";
import { createTestDB } from "../test-utils/db.js";
import { composeWrite } from "../db/database.js";
import { createNamespace } from "../db/api/namespace.js";
import { getDefaultPartition } from "../db/api/partition.js";
import { getGlueRelsByNamespace } from "../db/api/glue.js";
import { createServiceContext } from "./context.js";
import { create, updatePositionsInTx } from "./cards.js";
import { createInTx } from "./glues.js";

it("rolls back glue creation when composed alignment fails", async () => {
  const db = await createTestDB();
  const context = createServiceContext();
  const namespaceId = await createNamespace({ db, name: "Glue rollback" });
  const partition = await getDefaultPartition({ db, namespaceId });
  const cards = [];
  for (const content of ["one", "two"])
    cards.push(await create(db, context, namespaceId, { partitionId: partition!.id, content }));
  await expect(
    composeWrite(db, async (tx) => {
      await createInTx(tx, context, namespaceId, { cardIds: cards.map((card) => card.id) });
      await updatePositionsInTx(tx, context, namespaceId, {
        positions: [{ cardId: "missing", posX: 0, posY: 0 }],
      });
    }),
  ).rejects.toThrow("Some cards do not belong to this namespace");
  expect(await getGlueRelsByNamespace({ db, namespaceId })).toEqual([]);
});
