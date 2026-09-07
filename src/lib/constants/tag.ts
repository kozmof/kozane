/**
 * The tag grammar's own dimensions, and the ceilings a gather of tags runs under.
 *
 * `lib/tag.ts` builds its pattern out of the first few of these, so a change to a segment
 * length or a nesting depth is a change to what the grammar matches, not merely to what it
 * accepts afterwards. See the note on `TAG_RE` there.
 */
import { TASKSPACE_SSG_DEPTH_MAX } from "./taskspace.js";

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
