export type { Bundle, Scope, ScopeRel, GlueRel } from "../db/api/types.js";
import type { Card } from "../db/api/types.js";

export type CardData = Pick<Card, "id" | "content" | "bundleId" | "posX" | "posY" | "workingCopyId">;

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

export interface WorkingCopySummary {
  id: string;
  name: string;
  scopeId: string | null;
  path: string | null;
}
