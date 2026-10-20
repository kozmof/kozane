/**
 * Tag grammar limits and scan budgets.
 *
 * `lib/tag.ts` builds its pattern out of the first few of these, so a change to a segment
 * length or a nesting depth is a change to what the grammar matches, not merely to what it
 * accepts afterwards. See the note on `TAG_RE` there.
 */
import { TASKSPACE_SSG_DEPTH_MAX } from "./taskspace.js";

/** The character that opens a tag. See `lib/tag.ts` for the grammar it starts. */
export const TAG_SIGIL = ":";

/**
 * Maximum characters per tag segment. Reject longer candidates instead of truncating them.
 * This also limits accidental tags in text written without spaces.
 */
export const TAG_SEGMENT_CHARS_MAX = 64;

/** Maximum tag depth. For example, `:foo:bar:baz` has three levels. */
export const TAG_LEVELS_MAX = 8;

/**
 * Maximum excerpt length for a tag hit. Keep enough text to identify the match without
 * copying the full source into the index.
 */
export const TAG_EXCERPT_CHARS_MAX = 200;

/**
 * Maximum displayed hits per kind. Cap cards and file lines separately while retaining totals
 * from the gathered index.
 */
export const TAG_HITS_SHOWN_MAX = 200;

/**
 * Maximum file-content bytes read from one taskspace per tag scan. Report skipped content
 * when the budget is exhausted. Cached unchanged files avoid repeat reads.
 */
export const TAG_SCAN_TOTAL_BYTES_MAX = 8 * 1024 * 1024;

/**
 * Maximum entries visited in one taskspace scan. Bound traversal work even when entries
 * contain no readable content.
 */
export const TAG_SCAN_NODES_MAX = 20_000;

/**
 * Maximum file-content bytes read across a workspace gather. Apply this pool alongside each
 * taskspace's limit to bound total cold-read work. Cached files avoid repeat content reads.
 */
export const TAG_SCAN_WORKSPACE_BYTES_MAX = 4 * TAG_SCAN_TOTAL_BYTES_MAX;

/** Maximum entries visited across all taskspaces, alongside the workspace byte budget. */
export const TAG_SCAN_WORKSPACE_NODES_MAX = 4 * TAG_SCAN_NODES_MAX;

/**
 * Maximum hits produced by one taskspace scan. Bound results separately from bytes and
 * entries because short repeated tags can produce many hits. Report truncation so resulting
 * counts are understood as lower bounds.
 */
export const TAG_SCAN_HITS_MAX = 100_000;

/**
 * Maximum card hits gathered across the workspace. Bound the result array, derived tree, and
 * serialized payload, matching the file-side hit limit.
 */
export const TAG_CARD_HITS_MAX = 100_000;

/**
 * Maximum card rows held per tag-query page. Page by ID to bound memory while continuing
 * until the hit limit or end of results. A fixed row cap would miss tags after prefilter
 * matches that yield no hits.
 */
export const TAG_CARD_ROWS_PAGE = 1_000;

/**
 * Maximum example paths reported with a scan truncation. Keep enough to locate the problem
 * without listing every affected file.
 */
export const TAG_SCAN_TRUNCATED_PATHS_MAX = 5;

/**
 * Directory names excluded from tag scans at every depth. Skip generated and vendored output
 * so it does not consume the scan budget before authored files.
 *
 * These documented exclusions do not count as truncation. Do not consult `.gitignore`, whose
 * rules concern version control and may exclude notes users still want indexed.
 */
export const TAG_SCAN_SKIP_DIRS = [
  "node_modules",
  "bower_components",
  "vendor",
  "build",
  "dist",
  "out",
  "target",
  "coverage",
  "__pycache__",
  // Skip scratch output as well as build products. Dot-prefixed directories are already
  // excluded by directory listing.
  "tmp",
] as const;

/**
 * Maximum tag-scan directory depth. Match {@link TASKSPACE_SSG_DEPTH_MAX} because both scans
 * walk taskspace trees.
 */
export const TAG_SCAN_DEPTH_MAX = TASKSPACE_SSG_DEPTH_MAX;
