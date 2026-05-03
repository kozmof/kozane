import type { InferSelectModel } from "drizzle-orm";
import type { AnyDB } from "../client.js";
import type {
  projectTable,
  bundleTable,
  cardTable,
  scopeTable,
  scopeRelTable,
  glueTable,
  glueRelTable,
  workingCopyTable,
} from "../schema.js";

export type NeedsDB = { db: AnyDB };
export type NeedsProject = NeedsDB & { projectId: string };
export type NeedsBundle = NeedsDB & { bundleId: string };
export type NeedsScope = NeedsDB & { scopeId: string };
export type NeedsWorkingCopy = NeedsDB & { workingCopyId: string };

export type Project = InferSelectModel<typeof projectTable>;
export type Bundle = InferSelectModel<typeof bundleTable>;
export type Card = InferSelectModel<typeof cardTable>;
export type Scope = InferSelectModel<typeof scopeTable>;
export type ScopeRel = InferSelectModel<typeof scopeRelTable>;
export type Glue = InferSelectModel<typeof glueTable>;
export type GlueRel = InferSelectModel<typeof glueRelTable>;
export type WorkingCopy = InferSelectModel<typeof workingCopyTable>;
