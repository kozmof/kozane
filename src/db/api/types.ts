import type { InferSelectModel } from "drizzle-orm";
import type { AnyDB } from "../client.js";
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
export type NeedsProject = NeedsDB & { projectId: string };
export type NeedsBundle = NeedsDB & { bundleId: string };
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
