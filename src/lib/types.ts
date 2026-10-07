import type {
  Partition,
  Card,
  GlueRel,
  Layer,
  Scope,
  ScopeRel,
  ScopeArea,
  Taskspace,
  Warp,
} from "../db/api/types.js";

// `zIndex` is required because its column is NOT NULL DEFAULT 0. `width` stays nullable so
// cards can follow `ui.defaultCardWidth`.
export type CardData = Pick<
  Card,
  | "id"
  | "content"
  | "partitionId"
  | "layerId"
  | "posX"
  | "posY"
  | "taskspaceId"
  | "zIndex"
  | "width"
>;

export interface CardWithGlue extends CardData {
  glueId: string | null;
}

export interface PartitionWithColor {
  id: string;
  name: string;
  bg: string;
  dot: string;
  isDefault: boolean;
}

export type TaskspaceSummary = Pick<Taskspace, "id" | "name" | "scopeId" | "path" | "pathKind">;

/**
 * Directory entry metadata without file contents. Report symlinks as links and do not expand
 * them in the panel.
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
 * Shared tree-walk truncation reasons. Distinguish listing, depth, entry-budget, and read
 * failures so incomplete directories are not presented as empty. Individual scans can add
 * their own reasons.
 */
export type WalkTruncation = "entries" | "depth" | "nodes" | "unreadable";

/**
 * Reason a static-export directory listing is incomplete, or null when complete. Alias {@link
 * WalkTruncation} to share the walk's limits. Live listings can reach only the entry cap.
 */
export type TaskspaceTruncation = WalkTruncation;

/**
 * Embedded static-export tree node. Directories include children and readable files include
 * content because static pages have no file endpoint.
 *
 * Keep skipped files visible with a reason when size, encoding, or export budgets prevent
 * embedding them.
 */
export type TaskspaceFileNode =
  | {
      kind: "directory";
      name: string;
      children: TaskspaceFileNode[];
      truncated: TaskspaceTruncation | null;
    }
  | { kind: "file"; name: string; content: string; size: number }
  | {
      kind: "file-skipped";
      name: string;
      /** Unreadable files include permission failures and files removed after listing. */
      reason: "too-large" | "not-text" | "budget" | "unreadable";
      size: number | null;
    }
  | { kind: "symlink" | "other"; name: string };

/** One taskspace's file tree, rooted at the taskspace directory itself. */
export interface TaskspaceFileTree {
  root: Extract<TaskspaceFileNode, { kind: "directory" }>;
}

/**
 * Tag source identity for a card or taskspace file. Join card metadata by ID instead of
 * copying it into every hit.
 *
 * File identity includes taskspace, path, and line. Card hits open the whole card and retain
 * matching text in the excerpt rather than a navigation line number.
 */
export type TagSource =
  | { kind: "card"; cardId: string }
  | { kind: "file"; taskspaceId: string; path: string; line: number };

/** One tag, once, where it was written. */
export interface TagHit {
  /** Full normalized tag without its sigil, such as `foo:bar:baz`. See `normalizeTag`. */
  tag: string;
  source: TagSource;
  /** The line the tag sits on, trimmed and capped. Enough to recognize the hit by. */
  excerpt: string;
}

/**
 * Reasons a tag scan may cover only part of a taskspace. Extend `WalkTruncation` with
 * tag-specific limits and failures.
 *
 * `budget` means the scan exhausted its byte allowance. `too-large` means a file exceeded the
 * per-file limit before it was opened. `unreadable` means reading failed. `hits` means scanning
 * found more tags than `TAG_SCAN_HITS_MAX` allows, so even the reported counts are lower
 * bounds.
 *
 * Keep this type shared between the filesystem scanner, CLI, and browser. `truncationReasons`
 * in `lib/tag.ts` supplies the display text.
 */
export type TagScanTruncation = WalkTruncation | "budget" | "hits" | "too-large";

/**
 * Everything a namespace board is drawn from. The snapshot endpoint answers with this and
 * the client reloads into it, so the two cannot drift into different shapes.
 *
 * It lives here rather than beside the client state that consumes it because a server
 * route also has to name it, and a `+server.ts` reaching into a `.svelte.ts` module points
 * the dependency the wrong way round.
 */
export interface NamespaceDataSnapshot {
  namespace: { id: string };
  cards: CardWithGlue[];
  partitions: Partition[];
  layers: Layer[];
  warps: Warp[];
  /**
   * Scopes visible to this namespace, not the complete workspace list. Use the workspace-wide
   * CLI listing for that view.
   */
  scopes: Scope[];
  scopeRels: ScopeRel[];
  /**
   * Scope frames on this board, each identified by its own ID. A scope can have multiple
   * frames or none.
   */
  scopeAreas: ScopeArea[];
  glueRels: GlueRel[];
  /** This namespace's taskspaces plus unplaced taskspaces. */
  taskspaces: TaskspaceSummary[];
  /**
   * Embedded file trees keyed by taskspace ID, present only in static exports that include
   * scoped files. Live boards fetch files on demand.
   */
  taskspaceFiles?: Record<string, TaskspaceFileTree>;
}

export type {
  Partition,
  Layer,
  Scope,
  ScopeRel,
  ScopeArea,
  GlueRel,
  Warp,
} from "../db/api/types.js";
