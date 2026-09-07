/**
 * The limits a taskspace's files are read under — a live listing, a single file, and the recursive walk a static export makes.
 *
 * The tag scan's own ceilings are in `tag.ts` beside the grammar they bound, and one of them
 * (`TAG_SCAN_DEPTH_MAX`) is defined as this file's depth limit rather than repeating it.
 */
/**
 * How many entries one directory listing may carry. A taskspace is an ordinary directory
 * the user works in, so it may well hold a `node_modules` — a listing has to stay a
 * listing rather than become a several-megabyte answer nobody asked for. The panel says
 * so when a directory is cut off.
 */
export const TASKSPACE_DIR_ENTRIES_MAX = 500;

/**
 * How large a file the editor will open, in bytes. The panel reads a file whole and hands
 * it to a piece table held in the tab, so the ceiling is what one browser tab can hold a
 * document in comfortably rather than what the disk can produce. A taskspace is an
 * ordinary working directory and may hold a database dump or a bundled asset; those are
 * refused by size before anything is read, not truncated into something that would save
 * back as a corrupted file.
 */
export const TASKSPACE_FILE_BYTES_MAX = 1_048_576;

/**
 * How many bytes of file content one taskspace may contribute to a static export in total,
 * across every file baked in by `kozane net ssg generate --include-scoped-files`. Unlike
 * the live panel, which reads one file at a time on demand, an export embeds everything up
 * front into a payload meant to be committed and published — so a taskspace pointed at a
 * large checkout needs a ceiling on the whole tree, not just on each file within it. Files
 * beyond the budget are still listed by name, with content withheld rather than the walk
 * simply stopping partway through the tree.
 */
export const TASKSPACE_SSG_TOTAL_BYTES_MAX = 20 * 1024 * 1024;

/**
 * How many directories deep a static export will walk into one taskspace. Not a UX limit —
 * a real project tree is expected to run deeper than this — but a finite backstop against a
 * pathological real (non-symlink) directory structure, since the export walk, unlike the
 * live panel, recurses through an entire taskspace in one pass rather than one directory at
 * a user's request.
 */
export const TASKSPACE_SSG_DEPTH_MAX = 64;

/**
 * How many entries — files, directories, and skipped files alike — one taskspace may
 * contribute to a static export in total. {@link TASKSPACE_SSG_TOTAL_BYTES_MAX} bounds only
 * what is read, and a name costs nothing to produce but is still shipped: a taskspace
 * pointed at an ordinary checkout holds a `node_modules` of a few hundred thousand entries,
 * which is a name-only tree of tens of megabytes on top of the content budget, walked with
 * an `lstat` apiece and baked into every project page of the export. This is what makes the
 * advertised ceiling a ceiling on the payload rather than only on the file content within
 * it. A directory cut off here says so, the same as one cut off by any other limit.
 */
export const TASKSPACE_SSG_NODES_MAX = 50_000;
