import { expect, it } from "vitest";
import { createTestDB } from "../test-utils/db.js";
import { createServiceContext } from "./context.js";
import * as namespaces from "./namespaces.js";
import { getAllLayers } from "../db/api/layer.js";
import { getAllPartitions } from "../db/api/partition.js";

it("changes the default and removes a namespace through shared services", async () => {
  const db = await createTestDB();
  const context = createServiceContext();
  const one = await namespaces.create(db, context, { name: " One " });
  const two = await namespaces.create(db, context, { name: "Two" });
  expect(await getAllLayers({ db, namespaceId: one.id })).toHaveLength(1);
  expect(await getAllPartitions({ db, namespaceId: one.id })).toHaveLength(1);
  expect(await namespaces.setDefault(db, context, one.id)).toEqual({ ok: true });
  expect(await namespaces.setDefault(db, context, two.id)).toEqual({ ok: true });
  expect(await namespaces.get(db, context, one.id)).toMatchObject({
    name: "One",
    isDefault: false,
  });
  expect(await namespaces.get(db, context, two.id)).toMatchObject({ isDefault: true });
  expect(await namespaces.remove(db, context, one.id)).toEqual({ ok: true });
  expect(await namespaces.list(db, context)).toEqual([{ ...two, isDefault: true }]);
  await expect(namespaces.get(db, context, one.id)).rejects.toMatchObject({
    name: "NotFoundError",
  });
  await expect(namespaces.setDefault(db, context, "missing")).rejects.toThrow();
  expect(await namespaces.get(db, context, two.id)).toMatchObject({ isDefault: true });
});
