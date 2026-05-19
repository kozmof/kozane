export type { Bundle, Scope, ScopeRel, GlueRel } from "../db/api/types.js";

export interface CardData {
  id: string;
  content: string;
  bundleId: string;
  posX: number;
  posY: number;
  workingCopyId: string | null;
}

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

export interface WorkingCopy {
  id: string;
  name: string;
  scopeId: string | null;
  path: string | null;
}
