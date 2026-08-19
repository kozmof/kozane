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
// `width` is the opposite case and stays nullable: null is a card that follows
// `ui.defaultCardWidth`, which is most of them.
export type CardData = Pick<
  Card,
  "id" | "content" | "bundleId" | "layerId" | "posX" | "posY" | "taskspaceId" | "zIndex" | "width"
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
 * One row of a taskspace directory listing. Names and metadata only — the listing endpoint
 * never reads a file, so nothing here can carry the contents of one.
 *
 * A symlink is reported as itself rather than as whatever it points at, and is not
 * expandable in the panel: following one is how a listing confined to a taskspace would
 * stop being confined to it.
 */
export type TaskspaceEntryKind = "directory" | "file" | "symlink" | "other";

export interface TaskspaceEntry {
  name: string;
  kind: TaskspaceEntryKind;
  /** Bytes, for regular files. Null for everything else, where a size means nothing. */
  size: number | null;
  modifiedAt: string | null;
}

export interface TaskspaceListing {
  /** The listed directory, relative to the taskspace root and always `/`-separated. */
  path: string;
  entries: TaskspaceEntry[];
  /** True when the directory held more than {@link TASKSPACE_DIR_ENTRIES_MAX} entries. */
  truncated: boolean;
}

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
