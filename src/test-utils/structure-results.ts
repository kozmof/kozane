import type {
  LayerCreateResult,
  LayerRemoveResult,
  NamespaceCreateResult,
  PartitionCreateResult,
  PartitionRemoveResult,
} from "../lib/backend/index.js";
/** Complete response fixtures shared by HTTP routing and decoding checks. */
export const structureResults = {
  "namespaces.create": {
    id: "n",
    name: "Namespace",
    isDefault: false,
  } satisfies NamespaceCreateResult,
  "layers.create": {
    id: "l",
    name: "Layer",
    position: 1,
    isDefault: false,
  } satisfies LayerCreateResult,
  "layers.rename": { ok: true },
  "layers.remove": {
    ok: true,
    defaultLayerId: "default-layer",
    stacking: [{ cardId: "c", zIndex: 3 }],
  } satisfies LayerRemoveResult,
  "layers.reorder": { ok: true },
  "partitions.create": { id: "p" } satisfies PartitionCreateResult,
  "partitions.rename": { ok: true },
  "partitions.remove": {
    ok: true,
    defaultPartitionId: "default-partition",
  } satisfies PartitionRemoveResult,
};
