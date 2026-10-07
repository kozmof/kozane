/**
 * Limits for live taskspace listings, editor reads, and recursive static exports. Tag scan
 * limits are defined in `tag.ts`.
 */
/** Maximum entries returned for one directory listing. Report when the result is truncated. */
export const TASKSPACE_DIR_ENTRIES_MAX = 500;

/**
 * Maximum file size the editor will open, in bytes. Reject oversized files before reading so
 * the editor cannot save a truncated copy.
 */
export const TASKSPACE_FILE_BYTES_MAX = 1_048_576;

/**
 * Maximum content bytes included per taskspace in a static export. List files beyond the
 * budget by name while withholding their content.
 */
export const TASKSPACE_SSG_TOTAL_BYTES_MAX = 20 * 1024 * 1024;

/**
 * Maximum directory depth for a recursive static export. Bound traversal of deeply nested
 * directory trees.
 */
export const TASKSPACE_SSG_DEPTH_MAX = 64;

/**
 * Maximum entries included per taskspace in a static export, including directories and
 * skipped files. Bound the name-only tree as well as file content, and report truncated
 * directories.
 */
export const TASKSPACE_SSG_NODES_MAX = 50_000;
