import type { InferSelectModel } from "drizzle-orm";
import type { AnyDB, Tx } from "../client.js";
import type {
  projectTable,
  bundleTable,
  layerTable,
  cardTable,
  scopeTable,
  scopeRelTable,
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
export type NeedsProject = NeedsDB & { projectId: string };
export type NeedsBundle = NeedsDB & { bundleId: string };
/**
 * A project and a batch of its cards — the shape every operation acting on a selection
 * takes, and the reason they can share one ownership check and one rejection vocabulary.
 * See {@link BatchRejection} in `utils.ts`.
 */
export type NeedsProjectCards = NeedsProject & { cardIds: string[] };
export type NeedsProjectBundle = NeedsProject & { bundleId: string };
export type NeedsProjectLayer = NeedsProject & { layerId: string };
export type NeedsProjectWarp = NeedsProject & { warpId: string };
export type NeedsScope = NeedsDB & { scopeId: string };
export type NeedsTaskspace = NeedsDB & { taskspaceId: string };

export type Project = InferSelectModel<typeof projectTable>;
export type Bundle = InferSelectModel<typeof bundleTable>;
export type Layer = InferSelectModel<typeof layerTable>;
export type Card = InferSelectModel<typeof cardTable>;
export type Scope = InferSelectModel<typeof scopeTable>;
export type ScopeRel = InferSelectModel<typeof scopeRelTable>;
export type Glue = InferSelectModel<typeof glueTable>;
export type GlueRel = InferSelectModel<typeof glueRelTable>;
export type Taskspace = InferSelectModel<typeof taskspaceTable>;
export type Warp = InferSelectModel<typeof warpTable>;
