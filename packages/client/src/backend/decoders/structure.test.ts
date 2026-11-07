import { expect, it } from "vitest";
import { structureResults } from "../../../../../src/test-utils/structure-results.js";
import {
  readMutationOk,
  readCreatedId,
  readNamespaceCreated,
  readLayerCreated,
  readLayerRemoved,
  readPartitionRemoved,
} from "./structure.js";

it("accepts complete namespace, layer and partition results", () => {
  expect(readNamespaceCreated(structureResults["namespaces.create"])).toEqual(
    structureResults["namespaces.create"],
  );
  expect(readLayerCreated(structureResults["layers.create"])).toEqual(
    structureResults["layers.create"],
  );
  expect(readLayerRemoved(structureResults["layers.remove"])).toEqual(
    structureResults["layers.remove"],
  );
  expect(readPartitionRemoved(structureResults["partitions.remove"])).toEqual(
    structureResults["partitions.remove"],
  );
  expect(readCreatedId(structureResults["partitions.create"])).toEqual({ id: "p" });
  expect(readMutationOk({ ok: true, privatePath: "/private" })).toEqual({ ok: true });
  expect(readLayerRemoved({ ok: true, defaultLayerId: "l", stacking: [] })).toEqual({
    ok: true,
    defaultLayerId: "l",
    stacking: [],
  });
});
it("rejects missing fields and invalid default metadata", () => {
  for (const value of [null, [], {}, { ok: false }, { ok: "true" }])
    expect(readMutationOk(value)).toBeNull();
  expect(readCreatedId({ id: "" })).toBeNull();
  expect(readNamespaceCreated({ id: "n", name: "Board", isDefault: true })).toBeNull();
  expect(readNamespaceCreated({ id: "n" })).toBeNull();
  for (const value of [
    { ...structureResults["layers.create"], position: Infinity },
    { ...structureResults["layers.create"], isDefault: true },
    { id: "l", name: "Layer" },
  ])
    expect(readLayerCreated(value)).toBeNull();
  expect(readPartitionRemoved({ ok: true })).toBeNull();
  expect(readPartitionRemoved({ ok: false, defaultPartitionId: "p" })).toBeNull();
});
it("rejects an entire reassignment result for missing or ambiguous stacking", () => {
  const base = { ok: true, defaultLayerId: "l" };
  for (const stacking of [
    null,
    [{}],
    [{ cardId: "c", zIndex: NaN }],
    [
      { cardId: "c", zIndex: 1 },
      { cardId: "c", zIndex: 2 },
    ],
  ]) {
    expect(readLayerRemoved({ ...base, stacking })).toBeNull();
  }
  expect(readLayerRemoved({ ...base, stacking: undefined })).toBeNull();
  expect(readLayerRemoved({ ok: false, defaultLayerId: "l", stacking: [] })).toBeNull();
});

it("accepts actual service results while cards are reassigned through layer and partition deletion", async () => {
  const { createTestDB } = await import("../../../../../src/test-utils/db.js");
  const { createServiceContext } = await import("../../../../../src/services/context.js");
  const namespaces = await import("../../../../../src/services/namespaces.js");
  const layers = await import("../../../../../src/services/layers.js");
  const partitions = await import("../../../../../src/services/partitions.js");
  const cards = await import("../../../../../src/services/cards.js");
  const { get } = await import("../../../../../src/services/snapshot.js");
  const db = await createTestDB();
  const context = createServiceContext();
  const namespace = await namespaces.create(db, context, { name: "Board" });
  expect(readNamespaceCreated(namespace)).toEqual(namespace);
  const layer = await layers.create(db, context, namespace.id, { name: "Notes" });
  expect(readLayerCreated(layer)).toEqual(layer);
  const partition = await partitions.create(db, context, namespace.id, { name: "Research" });
  expect(readCreatedId(partition)).toEqual(partition);
  const card = await cards.create(db, context, namespace.id, {
    content: "Retained card",
    partitionId: partition.id,
    layerId: layer.id,
  });
  expect(
    readMutationOk(await layers.rename(db, context, namespace.id, layer.id, { name: "Renamed" })),
  ).toEqual({ ok: true });
  const before = await get(db, context, namespace.id);
  const layerIds = before!.snapshot.layers.map((row) => row.id).reverse();
  expect(readMutationOk(await layers.reorder(db, context, namespace.id, { layerIds }))).toEqual({
    ok: true,
  });
  const removedLayer = await layers.remove(db, context, namespace.id, layer.id);
  expect(readLayerRemoved(removedLayer)).toEqual(removedLayer);
  expect(removedLayer.stacking).toEqual(
    expect.arrayContaining([expect.objectContaining({ cardId: card.id })]),
  );
  expect(
    readMutationOk(
      await partitions.rename(db, context, namespace.id, partition.id, { name: "Renamed" }),
    ),
  ).toEqual({ ok: true });
  const removedPartition = await partitions.remove(db, context, namespace.id, partition.id);
  expect(readPartitionRemoved(removedPartition)).toEqual(removedPartition);
  const after = await get(db, context, namespace.id);
  expect(after!.snapshot.cards).toEqual([
    expect.objectContaining({
      id: card.id,
      layerId: removedLayer.defaultLayerId,
      partitionId: removedPartition.defaultPartitionId,
    }),
  ]);
});
