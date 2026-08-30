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
 * How many hits of *each kind* one tag's panel draws, in the browser and in a static export
 * alike: at most this many cards, and at most this many file lines.
 *
 * Every other walk on the tag path is bounded and this one has to be too, for the reason the
 * scan budgets give: a tag written in a header comment reaches every file carrying that
 * header, and a page that answers with forty thousand rows is not a more useful answer than
 * one that answers with two hundred and says there are more. The tree above it still counts
 * every hit, so the number beside a tag is the true one — this bounds only what is listed.
 *
 * A ceiling per kind rather than one over the list as a whole, because the list is not a
 * mixture: `loadTagIndex` returns every card hit before any file hit, so a single ceiling was
 * spent on cards before the files were reached and a much-tagged card set hid the files
 * completely. `capHitsByKind` in `lib/tag.ts` is where both ends apply it.
 */
export const TAG_HITS_SHOWN_MAX = 200;

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
 * How many bytes of file content one *gather* will read, across every taskspace in it.
 *
 * {@link TAG_SCAN_TOTAL_BYTES_MAX} bounds one taskspace and this bounds the loop over them,
 * which was unbounded: a workspace with twelve taskspaces could spend twelve times the
 * per-taskspace ceiling on one page load, and the walk behind it is synchronous, so the
 * server does nothing else — not even the board's poll — until it ends. A ceiling per
 * taskspace says how much any one of them may cost; only a ceiling across them says how much
 * the page may.
 *
 * Both apply, and the smaller of the two binds: a taskspace never reads more than its own
 * ceiling however much of the pool is left, so the first taskspace in the list cannot spend
 * the gather on itself and leave the rest reported as unread.
 *
 * Set to four taskspaces at their full ceiling, which is more than a gather that finds
 * anything actually costs — a cache hit is free, so this bounds the cold read and not the
 * rhythm of a workspace being used.
 */
export const TAG_SCAN_WORKSPACE_BYTES_MAX = 4 * TAG_SCAN_TOTAL_BYTES_MAX;

/** How many entries one gather will walk, across every taskspace in it. The counterpart to
 *  {@link TAG_SCAN_WORKSPACE_BYTES_MAX} for the other budget, and set the same way. */
export const TAG_SCAN_WORKSPACE_NODES_MAX = 4 * TAG_SCAN_NODES_MAX;

/**
 * How many hits one taskspace's scan will gather before it stops.
 *
 * The third budget, and the one the other two do not imply. Bytes and entries bound what is
 * *read*; neither bounds what reading produces, and the ratio between them is not fixed —
 * a line of prose yields no hit, while a line reading `'a` yields one per three bytes. So
 * {@link TAG_SCAN_TOTAL_BYTES_MAX} of such lines is some millions of hits out of a budget
 * that was doing exactly what it was set to do.
 *
 * That is not a hypothetical shape. It is what a generated file, a fixture of test data, or
 * a minified bundle that escaped {@link TAG_SCAN_SKIP_DIRS} looks like, and the cost of it
 * was not a slow page: the hits of every taskspace are gathered into one array, so a few
 * million of them exhausted memory, and the array was spread into that gather as arguments —
 * which throws `RangeError: Maximum call stack size exceeded` somewhere past a hundred
 * thousand or so. A budget that is spent honestly took the page down.
 *
 * Reported as a truncation like any other ceiling, rather than silently cutting the list.
 * The tag *tree* is built from these hits, so a scan that stopped here has undercounted
 * every tag in that taskspace, and the reader has to be told that the numbers beside them
 * are a floor.
 *
 * Set well above what a taskspace of notes reaches — a hit is a tag someone wrote, and a
 * hundred thousand of them is already a taskspace no one is reading tag by tag.
 */
export const TAG_SCAN_HITS_MAX = 100_000;

/**
 * How many hits one gather takes from the cards of a workspace before it stops.
 *
 * {@link TAG_SCAN_HITS_MAX} for the other source, and it was missing — the file walk was
 * bounded three ways over and the card query was bounded not at all, though both ends fill
 * the same array, are serialized into the same cache file, and are sent to the same page. A
 * card is bounded in length by `ui.contentMax` and a workspace is bounded in cards by nothing
 * whatever, so "every tagged card in the workspace" is not a quantity this code knows.
 *
 * The asymmetry was easy to miss because the failures differ. The file side fell over loudly
 * — `RangeError` out of a spread, recorded above — while the card side merely grows: a
 * larger array, a larger tree built from it, a larger payload, and a cache file that
 * eventually crosses {@link TAG_CACHE_BYTES_MAX} and is silently never written again, so the
 * workspace pays a cold gather on every page load with nothing saying why.
 *
 * Set to the same number as the file side, since it answers the same question about the same
 * array. A hit is a tag someone wrote, and a hundred thousand of them is past the point where
 * a person is reading an index tag by tag.
 */
export const TAG_CARD_HITS_MAX = 100_000;

/**
 * How many card rows one statement of the card gather brings back.
 *
 * {@link TAG_CARD_HITS_MAX} bounds what the gather *keeps*; this bounds what it holds in
 * order to decide. The two are not the same ceiling and the gap between them was the whole
 * of what was left unbounded: the query asked for every card in the workspace holding an
 * apostrophe, materialized `content` for all of them, and only then counted hits in a loop
 * — so a workspace past the hit ceiling read its way to that ceiling through every card
 * anyway. The file side has always charged for a file's bytes *before* reading it; this is
 * the same discipline on the other source.
 *
 * Read as pages keyed on the card id rather than as one statement with a row limit, because
 * a row limit is the wrong ceiling to state: the prefilter is deliberately generous — a card
 * reading `don't` comes back and yields nothing — so a cap on rows would stop the gather
 * short of tags that are there, and report a truncation for a workspace that has none. Paging
 * keeps the hit ceiling exact and bounds only how much is in hand at once.
 *
 * Keyed on the id, and not by offset: `card.id` is a uuidv7 primary key, so the index already
 * orders it and each page costs a seek rather than a re-count of everything skipped.
 *
 * Sized against `ui.contentMax`, which is what one row can cost — a thousand rows of the
 * 10,000-character default is a few tens of megabytes at worst and far less in practice,
 * against a local statement per page that a workspace of any ordinary size runs once or
 * twice.
 */
export const TAG_CARD_ROWS_PAGE = 1_000;

/**
 * How many of the paths behind a taskspace's truncation are carried with it.
 *
 * A sample, because the reason alone leaves the reader nowhere to look, and the whole set
 * would be a notice too large to read — carried through the cache and out to the page, for a
 * taskspace whose every file is unreadable. Enough to recognize the shape of the problem: one
 * stray video beside the notes reads differently from five files under the same directory.
 */
export const TAG_SCAN_TRUNCATED_PATHS_MAX = 5;

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
  // Scratch output rather than a build product, and it earns its place the same way: measured
  // on Kozane's own checkout, `tmp` was the directory that blew the entry cap and made every
  // scan of the repository report itself as not read in full. Dot-named scratch directories
  // (`.cache`, `.svelte-kit`, `.venv`) need no entry here — `listTaskspaceDirectory` never
  // returns a dot-entry, so the walk cannot reach one to begin with.
  "tmp",
] as const;

/**
 * How many directories deep a tag scan will walk. A backstop against a pathological real
 * directory structure, exactly as {@link TASKSPACE_SSG_DEPTH_MAX} is, and the same value:
 * the two walks go equally deep because they walk the same kind of tree.
 */
export const TAG_SCAN_DEPTH_MAX = TASKSPACE_SSG_DEPTH_MAX;

/**
 * How many scopes a gathered tag index keeps. A workspace has few projects and the index is
 * looked at one scope at a time, so this is a backstop against a file that grows forever
 * rather than a limit anyone reaches: at a realistic size one scope is around a megabyte.
 */
export const TAG_CACHE_SCOPES_MAX = 16;

/**
 * How many taskspace directories a gathered tag index keeps parsed files for — in this
 * process and in the file on disk alike.
 *
 * One number for both, because they hold the same directories: a memory ceiling below the
 * file's would mean re-importing on every scan what was evicted from one but kept in the
 * other. It was two constants in two modules, each with a comment saying it had to equal the
 * other, which is a convention rather than a guarantee.
 *
 * The precise cleanup is neither of them: a gather across the whole workspace knows every
 * taskspace there is and drops what is not among them. This bounds the case that cannot do
 * that — a workspace only ever looked at one project at a time, or a long-lived `kozane open`
 * against taskspaces that come and go — and is set well above the number anyone has, so that
 * eviction is the exception rather than the rhythm.
 */
export const TAG_CACHE_DIRS_MAX = 64;

/**
 * How large the gathered tag index on disk may be before it is ignored and rebuilt.
 *
 * The one ceiling the cache did not have. {@link TAG_CACHE_SCOPES_MAX} and
 * {@link TAG_CACHE_DIRS_MAX} bound how many entries it keeps and neither bounds how large
 * one is: a scope holds every tagged card in the workspace with a line of each, and a
 * directory holds every parsed file with the tags of each, so the file's size follows the
 * workspace's rather than anything set here.
 *
 * It has to be bounded because of where it is read. `readTagCache` is `readFileSync` and
 * `JSON.parse` on the path a page load and a `kozane tag` run wait on — the same synchronous
 * blocking {@link TAG_SCAN_WORKSPACE_BYTES_MAX} exists to bound for the walk, which was
 * bounded while the read of what the walk produced was not. A cache large enough to cost
 * more to read than the gather it saves is worse than no cache.
 *
 * Ignored and rebuilt rather than trimmed, because trimming means deciding which scope or
 * which directory to drop while holding the parsed file this is trying to avoid parsing.
 * Rebuilding writes a smaller file only if the workspace has shrunk, so a workspace that is
 * genuinely this size pays a cold read every time — which is the honest outcome, and the
 * signal that {@code ?files=0} or a narrower project is the answer rather than a bigger
 * ceiling.
 *
 * Set above what a realistic workspace reaches and no further, which is a smaller number than
 * it looks: {@link TAG_CACHE_SCOPES_MAX} scopes at the megabyte a scope is reckoned at is
 * sixteen, and this is that with room to spare. It was four times higher, on the reasoning
 * that a ceiling should be generous — but generosity is the wrong direction for this one.
 * Every byte under it is a byte that may be read synchronously while a page load waits, so
 * the ceiling *is* the worst case it permits, and setting it far above the workspaces that
 * exist only widens the window in which the cache costs more than the gather it replaces.
 * A workspace that genuinely exceeds this is told the truth by paying a cold read, and that
 * is a better answer than a hundred-millisecond stall on every navigation.
 *
 * Checked when the file is written as well as when it is read, and the write side is what
 * makes "pays a cold read every time" true rather than "pays a cold read *and* a wasted
 * write every time". Read alone, the ceiling refuses a file that the very next gather
 * serializes and lays down again — megabytes through `JSON.stringify` and out to disk, once
 * per page load, to produce a file this build has already decided it will never read. A
 * cache too large to be read is not a cache, so it is not written either.
 */
export const TAG_CACHE_BYTES_MAX = 16 * 1024 * 1024;
