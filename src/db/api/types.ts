import type { InferSelectModel } from "drizzle-orm";
import type { AnyDB, Tx } from "../client.js";
import type {
  namespaceTable,
  partitionTable,
  layerTable,
  cardTable,
  scopeTable,
  scopeRelTable,
  scopeAreaTable,
  glueTable,
  glueRelTable,
  taskspaceTable,
  warpTable,
} from "../schema.js";

export type NeedsDB = { db: AnyDB };
/**
 * Require a branded transaction handle for operations that run inside a caller-owned
 * transaction. A plain DB handle cannot satisfy this type.
 */
export type NeedsTx = { db: Tx };
/**
 * Shared single-entity ID parameters. Compose compound argument types through intersections
 * so each field has one declaration.
 */
export type NeedsNamespace = NeedsDB & { namespaceId: string };
export type NeedsPartition = NeedsDB & { partitionId: string };
export type NeedsLayer = NeedsDB & { layerId: string };
export type NeedsWarp = NeedsDB & { warpId: string };
export type NeedsScope = NeedsDB & { scopeId: string };
export type NeedsTaskspace = NeedsDB & { taskspaceId: string };
export type NeedsCards = NeedsDB & { cardIds: string[] };

/**
 * Namespace and card IDs for a batch operation. Share ownership checks and {@link
 * BatchRejection} reasons across operations.
 */
export type NeedsNamespaceCards = NeedsNamespace & NeedsCards;
export type NeedsNamespacePartition = NeedsNamespace & NeedsPartition;
export type NeedsNamespaceLayer = NeedsNamespace & NeedsLayer;
export type NeedsNamespaceWarp = NeedsNamespace & NeedsWarp;

export type Namespace = InferSelectModel<typeof namespaceTable>;
export type Partition = InferSelectModel<typeof partitionTable>;
export type Layer = InferSelectModel<typeof layerTable>;
export type Card = InferSelectModel<typeof cardTable>;
export type Scope = InferSelectModel<typeof scopeTable>;
export type ScopeRel = InferSelectModel<typeof scopeRelTable>;
export type ScopeArea = InferSelectModel<typeof scopeAreaTable>;
export type Glue = InferSelectModel<typeof glueTable>;
export type GlueRel = InferSelectModel<typeof glueRelTable>;
export type Taskspace = InferSelectModel<typeof taskspaceTable>;
export type Warp = InferSelectModel<typeof warpTable>;
