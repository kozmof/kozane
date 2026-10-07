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

// zIndex is required: the column is NOT NULL DEFAULT 0, so every card the server
// hands out has one, and making it optional here only spread `?? 0` through the UI.
// `width` is the opposite case and stays nullable: null is a card that follows
// `ui.defaultCardWidth`, which is most of them.
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
 * The limits any walk of a taskspace directory tree stops at, and the vocabulary the two
 * walks below both draw from.
 *
 * Named because the two of them shared these four members by writing them out twice, which
 * is a convention rather than a relationship: renaming `"nodes"` on one side, or adding a
 * fifth shared limit to one walk and not the other, left the pair silently disagreeing about
 * words the same page prints. What is genuinely particular to one walk stays particular to
 * it — see {@link TagScanTruncation}, which extends this and says why.
 *
 * Each is a distinct thing to be told, because a directory that ran past the entry cap, one
 * that sat deeper than the walk goes, one that arrived after the tree's total entry budget
 * was spent, and one that could not be read at all all leave a node that would otherwise be
 * indistinguishable from a genuinely empty directory.
 */
export type WalkTruncation = "entries" | "depth" | "nodes" | "unreadable";

/**
 * Why a directory is not all there in a static export, or null when it is. Exactly
 * {@link WalkTruncation}: the export walk stops at the shared limits and at nothing else. An
 * alias rather than the four members again, so that a limit added to one walk is a decision
 * about which of them it belongs to rather than a line copied into both.
 *
 * A live listing only ever reaches the entry cap.
 */
export type TaskspaceTruncation = WalkTruncation;

/**
 * One entry of a taskspace's file tree as `kozane net ssg generate --include-scoped-files`
 * bakes it into a static export. The counterpart to {@link TaskspaceEntry} for a listing
 * read once at build time rather than per directory on demand: a directory carries its
 * children inline, and a file carries its content inline — there is no further request the
 * static page could make to fetch either.
 *
 * A file too large, not valid UTF-8 text, or past the taskspace's total byte budget is
 * `file-skipped` rather than omitted outright, so the tree still shows it was there and why
 * nothing came back for it — the same reasons the live editor already answers with, plus
 * `"budget"` for the export-only total-size ceiling.
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
      /** `"unreadable"` covers the same rare, permission/race cases the live editor answers
       *  with 403/404 for — the file was there when its directory was listed but not when
       *  the export went to read it. */
      reason: "too-large" | "not-text" | "budget" | "unreadable";
      size: number | null;
    }
  | { kind: "symlink" | "other"; name: string };

/** One taskspace's file tree, rooted at the taskspace directory itself. */
export interface TaskspaceFileTree {
  root: Extract<TaskspaceFileNode, { kind: "directory" }>;
}

/**
 * Where a tag was written. The two things a workspace holds text in, and the only place the
 * card path and the file path differ at all: one grammar reads both (`scanTagLines` in
 * `lib/tag.ts`), and each caller wraps what comes back in the source it knows.
 *
 * Identity, and nothing a row already holds. A card's partition, position, and layer are
 * columns of `card`, so a reader that wants them joins by `cardId` against cards it has
 * already got — the board keeps every one of them in its snapshot. Copying them in here
 * would put a second, staler copy of those columns behind every occurrence of every tag.
 *
 * A file is the other case rather than the same duplication: nothing anywhere holds a row
 * for one, so the taskspace, the path within it, and the line are its identity.
 *
 * That is also why only one of the two carries a `line`, though `scanTagLines` computes it
 * for both. A file hit is a place to go and look, and the line is half of where; a card hit
 * opens the card, which is one place however many of its lines carry the tag — a line number
 * there would be a field every reader has to decide to ignore. What the line was needed for
 * is already kept: `excerpt` is that line, so a card matched deep in its text shows the text
 * that matched rather than its opening words. `hitRowKey` in `lib/tag.ts` is where the two
 * grains meet, and is the only place that needs to know they differ.
 */
export type TagSource =
  | { kind: "card"; cardId: string }
  | { kind: "file"; taskspaceId: string; path: string; line: number };

/** One tag, once, where it was written. */
export interface TagHit {
  /** Normalized and whole: `foo:bar:baz`, without the sigil. See `normalizeTag`. */
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
   * Not every scope in the workspace: the ones this namespace has reason to draw, as
   * `getScopesInNamespace` decides. A scope another namespace alone is working in is absent,
   * and the client must not treat this as the full list — `kozane scope list` is that.
   */
  scopes: Scope[];
  scopeRels: ScopeRel[];
  /**
   * Where those scopes are framed on this board. Any number per scope, each identified by its
   * own `id` rather than its `scopeId`, and most scopes have none: an area is drawn only for a
   * scope someone has given a place to. Narrowed the same way `scopes` is — another
   * namespace's frames are not this board's business.
   */
  scopeAreas: ScopeArea[];
  glueRels: GlueRel[];
  /** Likewise narrowed: this namespace's taskspaces, plus the ones assigned to no namespace. */
  taskspaces: TaskspaceSummary[];
  /**
   * Present only in a static export built with `--include-scoped-files`: one file tree per
   * taskspace that had a resolvable path, keyed by taskspace id. Absent everywhere else —
   * the live board reads files on demand through the real endpoints and never needs this.
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
