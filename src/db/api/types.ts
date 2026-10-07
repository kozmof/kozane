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
 * For the operations that must run inside a transaction someone else opened, and say so in
 * their type rather than in their name. `Tx` is the branded transaction handle from
 * `db/tx.ts`, so a caller holding a plain `DB` cannot reach one of these by accident.
 *
 * Named here beside {@link NeedsDB} because these functions take the same single-object
 * parameter every other query in this module takes — the alternative, a positional
 * `(db, ids)`, was two arguments of the same shape as everything else's first two and read
 * differently for no reason.
 */
export type NeedsTx = { db: Tx };
/**
 * One entity each, and the only place each id is spelled.
 *
 * The compounds below are intersections of these rather than fresh object literals, which
 * is a correction and not a tidy-up: `NeedsNamespacePartition` used to be written
 * `NeedsNamespace & { partitionId: string }`, so `{ partitionId: string }` appeared twice
 * and the two spellings were held together by nobody. TypeScript is structural — the two
 * were the same type either way, which means a function declaring one has always accepted
 * the other, and the name never drew a distinction the compiler could check. Composing them
 * says that outright. A genuine distinction would need a brand, the way `DB` and `Tx` are
 * branded in `db/tx.ts`, and nothing here wants one: an argument bag is not a capability.
 */
export type NeedsNamespace = NeedsDB & { namespaceId: string };
export type NeedsPartition = NeedsDB & { partitionId: string };
export type NeedsLayer = NeedsDB & { layerId: string };
export type NeedsWarp = NeedsDB & { warpId: string };
export type NeedsScope = NeedsDB & { scopeId: string };
export type NeedsTaskspace = NeedsDB & { taskspaceId: string };
export type NeedsCards = NeedsDB & { cardIds: string[] };

/**
 * A namespace and a batch of its cards — the shape every operation acting on a selection
 * takes, and the reason they can share one ownership check and one rejection vocabulary.
 * See {@link BatchRejection} in `utils.ts`.
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
