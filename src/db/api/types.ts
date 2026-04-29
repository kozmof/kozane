import type { InferSelectModel } from "drizzle-orm";
import type { DB } from "../client";
import type {
  projectTable,
  bundleTable,
  cardTable,
  scopeTable,
  scopeRelTable,
  tieTable,
  workingCopyTable,
} from "../schema";

export type NeedsDB = { db: DB };
export type NeedsProject = NeedsDB & { projectId: string };
export type NeedsBundle = NeedsDB & { bundleId: string };
export type NeedsScope = NeedsDB & { scopeId: string };
export type NeedsWorkingCopy = NeedsDB & { workingCopyId: string };

export type Project = InferSelectModel<typeof projectTable>;
export type Bundle = InferSelectModel<typeof bundleTable>;
export type Card = InferSelectModel<typeof cardTable>;
export type Scope = InferSelectModel<typeof scopeTable>;
export type ScopeRel = InferSelectModel<typeof scopeRelTable>;
export type Tie = InferSelectModel<typeof tieTable>;
export type WorkingCopy = InferSelectModel<typeof workingCopyTable>;
