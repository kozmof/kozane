import type { Card, Taskspace } from "../db/api/types.js";

export type CardData = Pick<Card, "id" | "content" | "bundleId" | "posX" | "posY" | "taskspaceId"> &
  Partial<Pick<Card, "zIndex">>;

export interface CardWithGlue extends CardData {
  glueId: string | null;
}

export interface BundleWithColor {
  id: string;
  name: string;
  bg: string;
  dot: string;
  isDefault: boolean;
}

export type TaskspaceSummary = Pick<Taskspace, "id" | "name" | "scopeId" | "path" | "pathKind">;

export type { Bundle, Scope, ScopeRel, GlueRel } from "../db/api/types.js";
