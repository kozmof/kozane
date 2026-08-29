export const CANVAS_W = 5600;
export const CANVAS_H = 4000;
/**
 * How much text one card holds by default. The workspace may raise or lower it with
 * `ui.contentMax`, so this is the fallback rather than the limit — read the setting
 * through `lib/server/content-limit.ts` and pass it to {@link contentLimitIssue}.
 */
export const CONTENT_MAX = 10_000;
/**
 * Why this card's text is past `contentMax`, or null when it is not, in the wording both
 * writers refuse it with. The HTTP routes turn it into a 400 and `kozane card add` into a
 * failed command: the two reach the same table through the same `addCard`, so the limit
 * held against a card has to be one limit rather than one each.
 *
 * The limit is a parameter rather than read here because it comes from the workspace
 * config, which this module cannot reach — `ui-config.ts` imports from it, not the other
 * way round. That is the same split `clampToBounds` and `canvasBounds` have.
 */
export function contentLimitIssue(content: string, contentMax: number): string | null {
  return content.length > contentMax
    ? `content must be a string under ${contentMax} characters`
    : null;
}
export const NAME_MAX = 255;
/**
 * How many ids one request may name. Every batch endpoint binds a parameter per id, and the
 * position and stacking updates bind several — SQLite refuses a statement past its variable
 * limit, and builds the whole thing in memory before finding out. This sits far enough
 * under that to leave room for the widest of those statements, and far enough above any
 * real selection that reaching it means something other than a user dragging cards.
 */
export const BATCH_MAX = 2_000;
/**
 * How many rows one multi-row INSERT carries. The same SQLite variable limit
 * {@link BATCH_MAX} answers for, from the other side: there a request names ids and each
 * binds one parameter or a few, while here every column of every row binds one, so a row
 * count SQLite is happy with is far lower than an id count. Kept next to `BATCH_MAX` so
 * a table that grows a column is one place to revisit rather than two — a caller may hand
 * an insert up to `BATCH_MAX` rows, and this is what splits them.
 *
 * Small enough to stay well clear of the limit, large enough that an ordinary squash is a
 * single statement.
 */
export const INSERT_CHUNK_MAX = 200;

/**
 * How many bound parameters one INSERT may carry. {@link INSERT_CHUNK_MAX} is a row count,
 * which only stands in for this while every caller inserts a row of about the same width —
 * so this is the budget the row count was picked against, named so a wider table shrinks
 * its own batches instead of quietly spending more of it.
 *
 * SQLite's own ceiling is 32766 parameters per statement on any build Kozane runs against
 * (999 before 3.32, which predates the `node:sqlite` era entirely). Well under either, for
 * the reason {@link BATCH_MAX} gives: the statement is assembled in memory before SQLite
 * says whether it will take it.
 */
export const INSERT_PARAMS_MAX = 2_000;

/**
 * Splits rows into statement-sized batches. Here rather than beside any one caller because
 * several writers run the same insert — the board's squash endpoint and `kozane card
 * squash` among them — and a chunk size applied on one path only leaves the variable limit
 * still waiting on the other.
 *
 * `columnsPerRow` is what keeps the batch honest for a table wider than the one this was
 * sized against: the batch is the smaller of {@link INSERT_CHUNK_MAX} rows and whatever
 * {@link INSERT_PARAMS_MAX} affords at that width, so a table that grows a column narrows
 * its batches rather than widening its statements. Omitted, the row count stands alone, as
 * it did before — callers inserting a two-column relation row have nothing to gain from it.
 */
export function chunked<T>(
  rows: T[],
  { size = INSERT_CHUNK_MAX, columnsPerRow }: { size?: number; columnsPerRow?: number } = {},
): T[][] {
  const affordable = columnsPerRow
    ? Math.max(1, Math.floor(INSERT_PARAMS_MAX / columnsPerRow))
    : size;
  const batchSize = Math.min(size, affordable);
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += batchSize)
    chunks.push(rows.slice(start, start + batchSize));
  return chunks;
}

/**
 * How a taskspace's stored `path` is to be read: relative to the workspace root, which
 * keeps a workspace portable, or as an absolute path, which is what `kozane taskspace
 * create --dir <outside-root>` records.
 *
 * Here rather than beside the column it types, because both sides of that column need it —
 * `taskspaceTable` declares the enum from this list, and `resolveTaskspacePath` decides
 * what to do with the value. A leaf module is the one place both can reach without either
 * importing the other.
 */
export const PATH_KINDS = ["project_relative", "absolute"] as const;
export type PathKind = (typeof PATH_KINDS)[number];

/** Name of the default layer every project is created with. */
export const DEFAULT_LAYER_NAME = "Base";
/** Name of the default bundle every project is created with. */
export const DEFAULT_BUNDLE_NAME = "General";
export const DEFAULT_SERVER_HOST = "127.0.0.1";
/**
 * Default port for `kozane open`. Picked to stay clear of ports popular tools take by
 * default (Vite 5173, Vite preview 4173, 3000, 8080, …) and of the Linux ephemeral range
 * (32768+), so a Kozane server and a project's own dev server can run side by side.
 */
export const DEFAULT_SERVER_PORT = 17173;
/** Default port for `kozane net ssg preview`, kept adjacent to {@link DEFAULT_SERVER_PORT}. */
export const DEFAULT_PREVIEW_PORT = 17174;
/**
 * The keys the browser UI moves between warps with, on their own and with `Shift` for the
 * warp palette. Reserved: a shortcut bound to one of these would fire alongside the jump
 * the same press makes, so `ui.*Shortcut` may not take them.
 */
export const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * How many entries one directory listing may carry. A taskspace is an ordinary directory
 * the user works in, so it may well hold a `node_modules` — a listing has to stay a
 * listing rather than become a several-megabyte answer nobody asked for. The panel says
 * so when a directory is cut off.
 */
export const TASKSPACE_DIR_ENTRIES_MAX = 500;

/** The character that opens a tag. See `lib/tag.ts` for the grammar it starts. */
export const TAG_SIGIL = "'";

/**
 * How long one level of a tag may be, in characters. A candidate with a longer level is not
 * a tag at all rather than a tag cut short — see the note on rejection in `lib/tag.ts`.
 *
 * It is a real limit rather than a formality, and Japanese is why. English prose ends a tag
 * at the next space, so a runaway one is unusual; 日本語 is written without spaces, so
 * `'分類` followed by the rest of a sentence runs to the next punctuation mark, and this is
 * what stops that from becoming a tag nobody meant to write. Kozane is built on the kozane
 * method, so that is not an edge case here.
 */
export const TAG_SEGMENT_CHARS_MAX = 64;

/**
 * How many levels deep a tag may go: `'foo:bar:baz` is three. Subcategories are for
 * narrowing a subject, and a tag past this is a path being kept in a card rather than a
 * category — the same judgement {@link TAG_SEGMENT_CHARS_MAX} makes about length.
 */
export const TAG_LEVELS_MAX = 8;

/**
 * How much of the line a tag sits on is kept as its excerpt. Enough to recognize the hit in
 * a list, not enough to make a tag index a second copy of every card and file it points at.
 */
export const TAG_EXCERPT_CHARS_MAX = 200;

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

/**
 * How many bytes of file content one tag scan will read from one taskspace. The counterpart
 * to {@link TASKSPACE_SSG_TOTAL_BYTES_MAX} for a walk that happens while someone waits,
 * rather than once at build time, so it is set lower: a tag index is worth a moment, not a
 * pass over a checkout. Files past the budget are reported as skipped rather than silently
 * carrying no tags, because "no tags in this file" and "this file was never read" are
 * different answers and only one of them is true.
 *
 * The cache is what keeps this from being paid twice — see `scanTaskspaceTags`. It bounds
 * the first scan of a taskspace, and an unchanged file is never re-read after it.
 */
export const TAG_SCAN_TOTAL_BYTES_MAX = 8 * 1024 * 1024;

/**
 * How many entries one tag scan will walk into one taskspace. The same argument
 * {@link TASKSPACE_SSG_NODES_MAX} makes — a name costs an `lstat` to produce even when
 * nothing is read from it — against a walk a page load is waiting on.
 *
 * A backstop rather than the limit that usually binds. {@link TAG_SCAN_SKIP_DIRS} keeps the
 * walk out of the directories that hold hundreds of thousands of entries, so what is left is
 * a working tree, and a working tree runs out of bytes long before it runs out of names.
 */
export const TAG_SCAN_NODES_MAX = 20_000;

/**
 * Directory names a tag scan does not walk into, at any depth.
 *
 * The same kind of rule as skipping dot-entries, and it earns its place the same way: these
 * hold generated or vendored output, not text anyone wrote a tag in, and they are big enough
 * to spend the whole of {@link TAG_SCAN_TOTAL_BYTES_MAX} before the walk reaches the working
 * tree. Measured on Kozane's own checkout, `build`, `coverage`, and `dist` took 6.5 MB of the
 * 8 MB budget and the scan ran out partway through `src` — so the tags a user actually wrote
 * were the ones that went missing, and the tags gathered were mostly quoted string literals
 * out of compiled JavaScript.
 *
 * Not reported as a truncation, for the same reason a dot-entry is not: a taskspace read to
 * the end of everything this scans *was* read in full, and warning about it on every page
 * would make the warning meaningless. What this excludes is documented instead — in
 * `docs/browser-ui-handbook.md`, `docs/security-matrix.md`, and `spec/cli.md`.
 *
 * Names rather than patterns, and a short list rather than a thorough one. A `.gitignore`
 * would be the thorough answer and is deliberately not consulted: it is a different question
 * (what should not be committed, which routinely includes notes and drafts someone would very
 * much want tagged), it varies per repository, and honouring it means a parser and a
 * precedence order for a scan that is meant to be cheap.
 */
export const TAG_SCAN_SKIP_DIRS: readonly string[] = [
  "node_modules",
  "bower_components",
  "vendor",
  "build",
  "dist",
  "out",
  "target",
  "coverage",
  "__pycache__",
];

/**
 * How many directories deep a tag scan will walk. A backstop against a pathological real
 * directory structure, exactly as {@link TASKSPACE_SSG_DEPTH_MAX} is, and the same value:
 * the two walks go equally deep because they walk the same kind of tree.
 */
export const TAG_SCAN_DEPTH_MAX = TASKSPACE_SSG_DEPTH_MAX;
