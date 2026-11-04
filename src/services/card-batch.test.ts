import { expect, it } from "vitest";
import { createTestDB } from "../test-utils/db.js";
import { composeWrite } from "../db/database.js";
import { createNamespace } from "../db/api/namespace.js";
import { getDefaultPartition } from "../db/api/partition.js";
import { getDefaultLayer } from "../db/api/layer.js";
import { cardTable, inventoryTable } from "../db/schema.js";
import { createServiceContext } from "./context.js";
import { createInTx } from "./card-batch.js";

it("accepts repeated segments and rolls back all batch writes on later failure", async () => {
  const db = await createTestDB();
  const namespaceId = await createNamespace({ db, name: "Batch" });
  const partition = await getDefaultPartition({ db, namespaceId });
  const layer = await getDefaultLayer({ db, namespaceId });
  const input = { partitionId: partition!.id, layerId: layer!.id, contents: ["same", "same"] };
  await expect(composeWrite(db, async tx => {
    const batch = await createInTx(tx, createServiceContext(), namespaceId, input);
    expect(batch.ids).toHaveLength(2);
    throw new Error("reference composition failed");
  })).rejects.toThrow("reference composition failed");
  expect(await db.select().from(cardTable)).toEqual([]);
  expect(await db.select().from(inventoryTable)).toEqual([]);
});
