import type { InferSelectModel } from "drizzle-orm";
import type { DB } from "../client";
import type {
  projectTable,
  bundleTable,
  cardTable,
  scopeTable,
  workingCopyTable,
} from "../schema";

export type WithDB = { db: DB };
export type Project = InferSelectModel<typeof projectTable>;
export type Bundle = InferSelectModel<typeof bundleTable>;
export type Card = InferSelectModel<typeof cardTable>;
export type Scope = InferSelectModel<typeof scopeTable>;
export type WorkingCopy = InferSelectModel<typeof workingCopyTable>;
