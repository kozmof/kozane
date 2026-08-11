import type { Card, Taskspace } from "../db/api/types.js";

// zIndex is required: the column is NOT NULL DEFAULT 0, so every card the server
// hands out has one, and making it optional here only spread `?? 0` through the UI.
export type CardData = Pick<
  Card,
  "id" | "content" | "bundleId" | "layerId" | "posX" | "posY" | "taskspaceId" | "zIndex"
>;

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

export type { Bundle, Layer, Scope, ScopeRel, GlueRel } from "../db/api/types.js";
