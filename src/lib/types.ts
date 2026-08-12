import type {
  Bundle,
  Card,
  GlueRel,
  Layer,
  Scope,
  ScopeRel,
  Taskspace,
  Warp,
} from "../db/api/types.js";

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

/**
 * Everything a project board is drawn from. The snapshot endpoint answers with this and
 * the client reloads into it, so the two cannot drift into different shapes.
 *
 * It lives here rather than beside the client state that consumes it because a server
 * route also has to name it, and a `+server.ts` reaching into a `.svelte.ts` module points
 * the dependency the wrong way round.
 */
export interface ProjectDataSnapshot {
  project: { id: string };
  cards: CardWithGlue[];
  bundles: Bundle[];
  layers: Layer[];
  warps: Warp[];
  scopes: Scope[];
  scopeRels: ScopeRel[];
  glueRels: GlueRel[];
  taskspaces: TaskspaceSummary[];
}

export type { Bundle, Layer, Scope, ScopeRel, GlueRel, Warp } from "../db/api/types.js";
