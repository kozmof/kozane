import { expect, it } from "vitest";
import { createTestDB } from "../test-utils/db.js";
import { createNamespace } from "../db/api/namespace.js";
import { getDefaultPartition } from "../db/api/partition.js";
import { createServiceContext } from "./context.js";
import { create } from "./cards.js";
import { get } from "./snapshot.js";

it("assembles browser snapshot data through shared services", async () => {
  const db = await createTestDB();
  const context = createServiceContext();
  const namespaceId = await createNamespace({ db, name: "Snapshot" });
  const partition = await getDefaultPartition({ db, namespaceId });
  const card = await create(db, context, namespaceId, {
    partitionId: partition!.id,
    content: "snapshot card",
  });
  const loaded = await get(db, context, namespaceId);
  expect(loaded?.snapshot.cards).toEqual(
    [card].map(({ placements: _placements, ...stored }) => stored),
  );
  expect(loaded?.snapshot.taskspaces).toEqual([]);
  expect(loaded?.snapshot.layers).toHaveLength(1);
  expect(await get(db, context, "missing")).toBeNull();
});
