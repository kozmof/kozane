import { expect, it } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import { createDatabaseAdapter, withTx, type DB, type DatabaseHandle } from "@kozane/core/database";
import { DEFAULT_PARTITION_NAME } from "@kozane/core";
import { layers, partitions, scopes, createServiceContext } from "@kozane/core/services";
import { createNamespace } from "./namespace.js";
import { getAllLayers } from "./layer.js";
import { getAllPartitions } from "./partition.js";
import { getScope } from "./scope.js";
import { getScopeAreasInNamespace } from "./scope-area.js";

/** Refuse direct DB mutations so the test verifies the real adapter transaction boundary. */
function transactionalOnly(db: DB) {
  const handle = new Proxy(db, {
    get(target, property) {
      if (["insert", "update", "delete", "run"].includes(String(property)))
        return () => {
          throw new Error("Service bypassed adapter.write");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createDatabaseAdapter(handle as DatabaseHandle, {
    write: (operation) => withTx(db, operation),
    read: async () => {
      throw new Error("Fixture does not use adapter.read");
    },
  });
}

it("routes layer, partition, scope and area writes through the adapter transaction", async () => {
  const db = await createTestDB();
  const namespaceId = await createNamespace({ db, name: "main" });
  const guarded = transactionalOnly(db);
  const context = createServiceContext();
  const layer = await layers.create(guarded, context, namespaceId, { name: "Draft" });
  await layers.rename(guarded, context, namespaceId, layer.id, { name: "Final" });
  expect((await getAllLayers({ db, namespaceId })).find(({ id }) => id === layer.id)?.name).toBe(
    "Final",
  );
  const partition = await partitions.create(guarded, context, namespaceId, { name: "Inbox" });
  await partitions.rename(guarded, context, namespaceId, partition.id, { name: "Archive" });
  expect(
    (await getAllPartitions({ db, namespaceId })).find(({ id }) => id === partition.id)?.name,
  ).toBe("Archive");
  const scope = await scopes.create(guarded, context, { name: "Scope" });
  await scopes.rename(guarded, context, namespaceId, scope.id, { name: "Renamed" });
  expect((await getScope({ db, scopeId: scope.id }))?.name).toBe("Renamed");
  const area = await scopes.createArea(guarded, context, namespaceId, scope.id, {
    posX: 0,
    posY: 0,
    width: 100,
    height: 100,
  });
  await scopes.updateArea(guarded, context, namespaceId, scope.id, area.id, {
    posX: 10,
    posY: 20,
    width: 200,
    height: 200,
  });
  expect(await getScopeAreasInNamespace({ db, namespaceId })).toMatchObject([
    { id: area.id, posX: 10, posY: 20 },
  ]);
  await scopes.removeArea(guarded, context, namespaceId, scope.id, area.id);
  expect(await getScopeAreasInNamespace({ db, namespaceId })).toEqual([]);
});

it("keeps transaction-bound creation and rename within a caller's rollback boundary", async () => {
  const db = await createTestDB();
  const namespaceId = await createNamespace({ db, name: "main" });
  const context = createServiceContext();
  const layer = await layers.create(db, context, namespaceId, { name: "Keep layer" });
  const partition = await partitions.create(db, context, namespaceId, { name: "Keep partition" });
  const scope = await scopes.create(db, context, { name: "Keep scope" });
  await expect(
    withTx(db, async (tx) => {
      await layers.renameInTx(tx, context, namespaceId, layer.id, { name: "Changed layer" });
      await partitions.renameInTx(tx, context, namespaceId, partition.id, {
        name: "Changed partition",
      });
      await scopes.renameInTx(tx, context, namespaceId, scope.id, { name: "Changed scope" });
      await layers.createInTx(tx, context, namespaceId, { name: "Discard layer" });
      await partitions.createInTx(tx, context, namespaceId, { name: "Discard partition" });
      const temporaryScope = await scopes.createInTx(tx, context, { name: "Discard scope" });
      const area = await scopes.createAreaInTx(tx, context, namespaceId, temporaryScope.id, {
        posX: 0,
        posY: 0,
        width: 100,
        height: 100,
      });
      await scopes.updateAreaInTx(tx, context, namespaceId, temporaryScope.id, area.id, {
        posX: 10,
        posY: 20,
        width: 200,
        height: 200,
      });
      throw new Error("Abort composed writes");
    }),
  ).rejects.toThrow("Abort composed writes");
  expect((await getAllLayers({ db, namespaceId })).map(({ name }) => name)).toEqual([
    "Base",
    "Keep layer",
  ]);
  expect((await getAllPartitions({ db, namespaceId })).map(({ name }) => name)).toEqual([
    DEFAULT_PARTITION_NAME,
    "Keep partition",
  ]);
  expect((await getScope({ db, scopeId: scope.id }))?.name).toBe("Keep scope");
  expect(await getScopeAreasInNamespace({ db, namespaceId })).toEqual([]);
});

it("rolls back an area removal when the caller's transaction fails", async () => {
  const db = await createTestDB();
  const namespaceId = await createNamespace({ db, name: "main" });
  const context = createServiceContext();
  const scope = await scopes.create(db, context, { name: "scope" });
  const area = await scopes.createArea(db, context, namespaceId, scope.id, {
    posX: 0,
    posY: 0,
    width: 100,
    height: 100,
  });
  await expect(
    withTx(db, async (tx) => {
      await scopes.removeAreaInTx(tx, context, namespaceId, scope.id, area.id);
      throw new Error("Abort removal");
    }),
  ).rejects.toThrow("Abort removal");
  expect(await getScopeAreasInNamespace({ db, namespaceId })).toMatchObject([{ id: area.id }]);
});
