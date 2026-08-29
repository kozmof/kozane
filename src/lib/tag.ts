import {
  TAG_EXCERPT_CHARS_MAX,
  TAG_LEVELS_MAX,
  TAG_SEGMENT_CHARS_MAX,
  TAG_SIGIL,
} from "./constants.js";
import type { TagHit, TagScanTruncation, TagSource } from "./types.js";
import { scanUrls, type UrlSpan } from "./urls.js";

/**
 * The tag grammar, in one place, for every caller: a card's text, a taskspace file's text,
 * the CLI, and the browser. A leaf module — nothing here reaches the database or the
 * filesystem, which is what lets `src/cli` (built by `tsc`), the server, and the board all
 * read tags by the same rules rather than by three that agree for now. The presentation
 * helpers at the foot of the file are here for the same reason: the terminal and the page
 * draw the same rows, so they group and label them with the same code.
 *
 * A tag is `'foo`, and subcategorizes as `'foo:bar:baz`:
 *
 * ```
 * sigil     '   preceded by start-of-line, whitespace, or an opening ( [ {
 * body      segment ( ":" segment )*
 * segment   [\p{L}\p{N}_-]+
 * ```
 *
 * The sigil is an apostrophe, which ordinary prose also uses, so three rules keep writing
 * from becoming tagging:
 *
 * - **A word boundary opens it.** `don't` and `x'foo` are words with an apostrophe in them,
 *   not tags.
 * - **A closing apostrophe cancels it.** `'quoted'` is a quoted word, so it is left as text.
 * - **A URL is an address, not text.** An apostrophe inside `http://…` opens nothing, so
 *   `http://example.com/('foo)` is one link rather than a link and a tag. Unlike the two
 *   rules above this one is not in the pattern — it cannot be, since the pattern is asked
 *   about one candidate at a time and a URL is a span around it. A URL's characters are
 *   therefore *cut out* before the pattern is asked anything: `scanTagMatches` below reads
 *   the gaps between the spans `lib/urls.ts` finds, each as its own text, so an address is
 *   not merely stepped over but is not there to be read.
 *
 *   Cut rather than stepped over, and the difference is the whole of the rule. Testing where
 *   a match *started* let a candidate that began outside a URL and ran into one through, so
 *   `see 'http://example.com'` gathered the tag `http` and `'todo:https://example.com`
 *   gathered `todo:https` — neither of which the card drew, because the renderer had always
 *   cut. The junk tag existed only in the index, and `'todo`, the one the writer meant,
 *   only on the card. Cutting is what the renderer was already doing; doing it here too is
 *   what makes the two one decision rather than two that nearly agree.
 *
 *   It is a rule of the grammar rather than of the renderer, deliberately:
 *   `lib/text-segments.ts` already had to know where URLs were in order to draw them as
 *   anchors, and when only it knew, a card was gathered under a tag the card itself did not
 *   draw. See `lib/urls.ts`.
 *
 * The second rule reaches one token, and deliberately: `'a phrase'` still tags `a`, because
 * deciding otherwise means scanning ahead for a closing quote that may be on another line,
 * or may be an apostrophe in a word, and guessing wrong in either direction is worse than
 * the small amount of noise this leaves. A tag nobody meant is one row in the index; a tag
 * silently swallowed is a card that cannot be found.
 *
 * ## What that costs in a file, which is a decision and not an oversight
 *
 * The rules above were weighed against prose, and a taskspace file is often not prose. In
 * source code `'…'` is a string delimiter, so a multi-token literal opens a tag the closing
 * rule never cancels: `from 'drizzle-orm'` yields `drizzle-orm`, and `echo 'hello world'`
 * yields `hello`. Scanned across a working tree that is real noise, and it is left in rather
 * than legislated away here, because every rule that would remove it — matching quotes across
 * a line, knowing which files are code, requiring two characters — either swallows tags
 * someone wrote or makes the grammar answer differently depending on where the text was
 * found, and one grammar for both sources is the property this module exists to hold.
 *
 * It is bounded on the other side instead, where the cost actually arises: the file scan does
 * not walk `node_modules`, `build`, `dist`, or the rest of `TAG_SCAN_SKIP_DIRS` in
 * `lib/constants.ts`, where compiled and vendored code lives and where nearly all of this
 * noise was measured.
 * A quoted literal in hand-written source still becomes a tag; it sits in the tree unread,
 * next to the tags that were meant.
 */

// Bounded rather than `+` on purpose, and it does two jobs. It enforces
// TAG_SEGMENT_CHARS_MAX and TAG_LEVELS_MAX in the pattern itself, so a candidate past
// either fails to match rather than being matched and then checked. And it bounds
// backtracking: the trailing lookaheads reject a candidate by failing after the body has
// been matched, which sends the engine back through the body looking for a shorter one, and
// an unbounded body would make that O(n) per position — quadratic over a file of the size
// the scanner is handed, from a line of nothing but apostrophes and letters.
const SEGMENT = String.raw`[\p{L}\p{N}_-]{1,${TAG_SEGMENT_CHARS_MAX}}`;

/**
 * The two lookaheads are what make an over-long or over-deep candidate *no tag at all*
 * rather than a truncated one:
 *
 * - `(?![\p{L}\p{N}_'-])` — the body must have run out of word characters on its own. A
 *   65-character run therefore matches nothing, because every shorter body the engine backs
 *   off to is still followed by a letter. It is also what cancels `'quoted'`, since a body
 *   followed by an apostrophe fails the same test.
 * - `(?!:[\p{L}\p{N}_-])` — no further level may be waiting. A ninth level fails here and
 *   keeps failing as the engine backs off level by level, so the whole candidate is
 *   rejected. A `:` *not* followed by a word character is allowed through, which is what
 *   lets `'foo:` be the tag `foo` with a colon after it.
 */
const TAG_RE = new RegExp(
  String.raw`(?<=^|[\s(\[{])${TAG_SIGIL}(${SEGMENT}(?::${SEGMENT}){0,${TAG_LEVELS_MAX - 1}})` +
    String.raw`(?![\p{L}\p{N}_'-])(?!:[\p{L}\p{N}_-])`,
  "gu",
);

/**
 * A tag as it is compared and indexed: lowercased, so `'Foo` and `'foo` are one tag, and
 * NFC-normalized, so two spellings of the same accented or Japanese text do not become two
 * tags in the index over a difference nothing renders.
 *
 * Lowercased *then* normalized, in that order and not the reverse. Case folding is not
 * guaranteed to preserve normal form — a handful of characters lower onto sequences that are
 * no longer NFC — so composing last is what actually makes the result an NFC string, which is
 * the whole property an index key is wanted for. Both sides of every comparison come through
 * here, so the two orders agree wherever they agree; this one is right where they do not.
 *
 * What was actually typed is not lost — every hit carries the line it sits on.
 */
export function normalizeTag(tag: string): string {
  return tag.toLowerCase().normalize("NFC");
}

/** The levels of a tag, outermost first: `foo:bar:baz` is `["foo", "bar", "baz"]`. */
export function splitTag(tag: string): string[] {
  return tag.split(":");
}

/**
 * Whether `tag` is `query` or sits under it. Prefix by level, not by character, which is the
 * whole point of subcategories: `foo` gathers `foo:bar:baz`, and does not gather `foobar`.
 *
 * `tag` must already be normalized; `query` need not be. See {@link tagMatcher}.
 */
export function tagMatches(query: string, tag: string): boolean {
  return tagMatcher(query)(tag);
}

/**
 * {@link tagMatches} with the query normalized once, for the callers that ask it of every hit
 * in a workspace — the index page's filter, the CLI's, and the server's.
 *
 * Only the query is normalized, and the asymmetry is the point rather than an oversight.
 * Every tag this is asked about came out of {@link normalizeTag} at the moment it was
 * matched — that is the only way a tag string is ever made, on either path — so folding and
 * composing it again is work with no answer in it, once per hit per gather. The query is the
 * one string that arrives from outside: a URL, a CLI argument, a person typing.
 *
 * So: `query` is whatever was asked for, `tag` is a normalized tag. That precondition is what
 * pays for the loop, and it is why {@link tagMatches} states it too — the two must agree, or
 * a caller reaching for the convenient one would get a different answer than the loop does.
 */
export function tagMatcher(query: string): (tag: string) => boolean {
  const q = normalizeTag(query);
  const prefix = `${q}:`;
  return (tag) => tag === q || tag.startsWith(prefix);
}

/** One tag found in a text, and exactly where it sits in it. */
export interface TagPosition {
  /** Normalized, and without the sigil. */
  tag: string;
  /** Offset of the sigil in the text as given. */
  index: number;
  /** How many characters the tag occupies, sigil included. */
  length: number;
}

/**
 * Every tag in a text, by position rather than by line — what a renderer needs, since it has
 * to cut the text around each tag to draw it as something other than plain text.
 *
 * Offsets, not a search for the tag's text: normalizing folds case and composes characters,
 * either of which can change a string's length, so looking the normalized tag back up in the
 * original is arithmetic that is right until it is quietly wrong. The regex already knows
 * where it matched.
 *
 * `urls` is taken rather than found again where the caller has already found them —
 * `lib/text-segments.ts` needs the very same spans to draw its anchors — so one text is
 * scanned for URLs once and the anchor and the cut come out of the one list. Omitted, they
 * are found here, which is what every other caller does.
 */
export function scanTagPositions(text: string, urls?: UrlSpan[]): TagPosition[] {
  // A text with no sigil holds no tag, and this is the cheapest way to know it. The URL scan
  // goes with it, so a card of prose — the common case — pays one substring search.
  if (!text.includes(TAG_SIGIL)) return [];
  return scanTagMatches(text, urls ?? scanUrls(text));
}

/**
 * The one scanner, which every reading of a text goes through: the index's, the terminal's,
 * and the card's.
 *
 * A URL is cut out rather than stepped over. The text is split at the spans `urls` names and
 * each gap is matched as its own text, so the pattern is never shown an address at all — and
 * a candidate running *into* one stops at its edge. `'todo:https://x.com` is the tag `todo`,
 * matched in the gap `'todo:`; `see 'http://x.com'` is no tag, because its gap is `see '` and
 * nothing follows the sigil. See the URL rule in the module note.
 *
 * Offsets are into `text` as given, not into the gap a match was found in: a renderer cuts
 * the original around them.
 */
function scanTagMatches(text: string, urls: UrlSpan[]): TagPosition[] {
  const positions: TagPosition[] = [];

  // The gaps between the spans, in order. `scanUrls` returns disjoint spans in ascending
  // order — `matchAll` cannot overlap and trimming only shortens one — so one pass builds
  // them, and a text holding no URL is the single gap of the whole text.
  const gaps: [number, number][] = [];
  let start = 0;
  for (const { url, index } of urls) {
    if (index > start) gaps.push([start, index]);
    start = index + url.length;
  }
  if (start < text.length) gaps.push([start, text.length]);

  for (const [from, to] of gaps) {
    // Sliced rather than matched in place from a bounded `lastIndex`, because the lookbehind
    // has to read a gap's first character as the start of a text — it is the start of one,
    // what precedes it being an address rather than prose. Matching in place would let the
    // last character of a URL open a tag on the far side of the cut.
    for (const match of text.slice(from, to).matchAll(TAG_RE)) {
      positions.push({
        tag: normalizeTag(match[1]),
        index: from + match.index,
        length: match[0].length,
      });
    }
  }
  return positions;
}

/** One tag found in a text, and where in that text it was found. */
export interface TagLineHit {
  /** Normalized, and without the sigil: `foo:bar:baz`. */
  tag: string;
  /** 1-based, counting the lines of the text as given. */
  line: number;
  /** The line the tag sits on, trimmed and cut to {@link TAG_EXCERPT_CHARS_MAX}. */
  excerpt: string;
}

/**
 * The line, trimmed, and cut to {@link TAG_EXCERPT_CHARS_MAX} — by character rather than by
 * UTF-16 code unit.
 *
 * `slice` cuts by code unit, which splits an astral character in half and leaves an unpaired
 * surrogate at the end of the excerpt. That is not a passing display problem: the excerpt is
 * written into `.kozane/tag-index.json` and read back from it, and every renderer draws the
 * half character as `�`. Astral characters are not exotic on this path — the grammar takes
 * Japanese and the length limits exist partly for it, and emoji sit in the same notes.
 *
 * The code-unit length is checked first, and settles it for nearly every line: a string can
 * only hold fewer characters than code units, so one short of the limit by that measure is
 * short of it by either, and the spread never happens.
 */
function excerptOf(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= TAG_EXCERPT_CHARS_MAX) return trimmed;

  const characters = [...trimmed];
  return characters.length > TAG_EXCERPT_CHARS_MAX
    ? `${characters.slice(0, TAG_EXCERPT_CHARS_MAX).join("")}…`
    : trimmed;
}

/**
 * Every tag in a text, with the line it was written on.
 *
 * The half of tagging that both sources share: a card and a taskspace file are both just
 * text, so each calls this and wraps what comes back in a source of its own (see `TagSource`
 * in `lib/types.ts`). Nothing else about the two paths differs, which is what keeps one
 * grammar from becoming two.
 *
 * A tag written twice on one line is reported once. The two hits would carry the same tag,
 * the same line, and the same excerpt, so the second says nothing the first did not.
 */
export function scanTagLines(text: string): TagLineHit[] {
  const hits: TagLineHit[] = [];
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    // Cheapest possible skip, and most lines take it: a line with no apostrophe cannot hold
    // a tag, and the scanner is handed whole files.
    if (!line.includes(TAG_SIGIL)) continue;

    let excerpt: string | null = null;
    const seen = new Set<string>();
    // Through the same scanner the card draws from, over one line rather than a whole text.
    // A line is a text like any other, which is what keeps the two readings one reading.
    for (const { tag } of scanTagPositions(line)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      excerpt ??= excerptOf(line);
      hits.push({ tag, line: index + 1, excerpt });
    }
  }

  return hits;
}

/**
 * The thing a hit was found in, as a key: the card, or the file, whichever tag matched and
 * wherever in it. Two tags on one card are one card, and two tags on two lines of one file
 * are one file — which is what "3 cards" on the index has to mean to be worth reading.
 *
 * Paired with {@link hitRowKey}, which is the same idea at a different grain. The two are
 * deliberately not one function: this one answers "how many things is this?", and a file is
 * one thing however many of its lines carry the tag.
 */
export function sourceKey(source: TagSource): string {
  return source.kind === "card"
    ? `card:${source.cardId}`
    : `file:${source.taskspaceId}:${source.path}`;
}

/**
 * The row a hit is drawn on, as a key. What {@link sourceKey} is for counting, this is for
 * listing, and the grain differs by source because what a reader would go and look at does:
 * a card is one place to open however many of its lines carry the tag, while each line of a
 * file is its own place to go.
 *
 * Here rather than in the two callers that need it. The terminal and the index page list the
 * same hits, and each had written this out — including the `kind === "file" ? … : ""` that a
 * narrowed union needs — which is two chances to group by different things and no way to
 * notice.
 */
export function hitRowKey(source: TagSource): string {
  return source.kind === "card"
    ? `card:${source.cardId}`
    : `file:${source.taskspaceId}:${source.path}:${source.line}`;
}

/**
 * A hit narrowed to the source it came from, so the caller that has already decided it is
 * listing cards gets `source.cardId` rather than a union it has to narrow again.
 *
 * Predicates rather than `hit.source.kind === "card"` written at each `filter`, because a
 * bare comparison does not narrow the array it filters: every caller then re-narrowed inside
 * the loop with a `continue` that could never fire, and read the identity it wanted off
 * whatever else was to hand. See {@link groupHitRows}.
 */
export type TagHitOf<T, K extends TagSource["kind"]> = T & {
  source: Extract<TagSource, { kind: K }>;
};

export const isCardHit = <T extends { source: TagSource }>(hit: T): hit is TagHitOf<T, "card"> =>
  hit.source.kind === "card";

export const isFileHit = <T extends { source: TagSource }>(hit: T): hit is TagHitOf<T, "file"> =>
  hit.source.kind === "file";

/** One tag's hits, split by the two things they can have been written in and each side cut
 *  to a ceiling, with what each side was cut down from. */
export interface CappedHits<T extends { source: TagSource }> {
  cards: TagHitOf<T, "card">[];
  files: TagHitOf<T, "file">[];
  /** How many there were before the cut. The tree beside the list counts every hit, so a
   *  list that shows fewer has to be able to say what it is a part of. */
  cardTotal: number;
  fileTotal: number;
}

/**
 * A tag's hits, capped per kind.
 *
 * Per kind, and that is the whole reason this exists rather than a `slice` at each caller.
 * `loadTagIndex` returns every card hit before any file hit, so one cap laid across the two
 * spent itself on cards: a tag written on more cards than the ceiling listed *no files at
 * all*, and the panel said only that it was showing the first two hundred of three hundred
 * — which reads as "there are no files under this tag" to the one person who came looking
 * for one. Two ceilings cannot starve each other.
 *
 * Both the live page and a static export cap through here, so the server's list and the
 * browser's come out the same. See `TAG_HITS_SHOWN_MAX`. The terminal caps through it too:
 * `kozane tag show` prints the same two lists.
 *
 * One pass, keeping and counting together, rather than two `filter`s and two `slice`s. The
 * point of a ceiling is that the answer is small however large the question is, and building
 * two full arrays of everything that matched in order to throw away all but the first two
 * hundred of each spent the whole of what the cap was there to avoid.
 */
export function capHitsByKind<T extends { source: TagSource }>(
  hits: T[],
  max: number,
): CappedHits<T> {
  const cards: TagHitOf<T, "card">[] = [];
  const files: TagHitOf<T, "file">[] = [];
  let cardTotal = 0;
  let fileTotal = 0;

  for (const hit of hits) {
    if (isCardHit(hit)) {
      cardTotal += 1;
      if (cards.length < max) cards.push(hit);
    } else if (isFileHit(hit)) {
      fileTotal += 1;
      if (files.length < max) files.push(hit);
    }
  }

  return { cards, files, cardTotal, fileTotal };
}

/**
 * How many cards and how many files a tag holds. Distinct ones, per {@link sourceKey},
 * rather than a count of hits.
 *
 * Kept apart because the two are gathered differently and a reader wants to know which is
 * which: cards are a database read, files a disk walk.
 */
export interface TagCounts {
  cards: number;
  files: number;
}

/** One node of the tag hierarchy the index page draws. */
export interface TagNode {
  /** The whole path down to this node: `foo:bar`. What a link to it names. */
  tag: string;
  /** This node's own level: `bar`. What is drawn beside its siblings. */
  name: string;
  children: TagNode[];
  /** Hits whose tag is exactly this node. */
  own: TagCounts;
  /** Hits on this node and everything under it — what `tagMatches` would gather. */
  total: TagCounts;
}

/**
 * A node while it is still being counted. The counts are sets of {@link sourceKey} rather
 * than numbers, because a distinct count cannot be arrived at by adding: the same card
 * reaches a node once per tag it carries, and reaches an ancestor once per descendant tag
 * as well.
 *
 * One set per kind, so counting is `size` rather than a walk that re-reads the `card:` prefix
 * off keys {@link sourceKey} wrote — a coupling between two functions that had no way to be
 * kept true, for a count the shape of the data already knows.
 */
type Tally = { cards: Set<string>; files: Set<string> };

type MutableNode = Omit<TagNode, "children" | "own" | "total"> & {
  children: Map<string, MutableNode>;
  own: Tally;
  total: Tally;
};

const emptyTally = (): Tally => ({ cards: new Set(), files: new Set() });

function emptyNode(tag: string, name: string): MutableNode {
  return { tag, name, children: new Map(), own: emptyTally(), total: emptyTally() };
}

const countKeys = ({ cards, files }: Tally): TagCounts => ({
  cards: cards.size,
  files: files.size,
});

// Names differing only in case would otherwise order arbitrarily between runs, the same
// concern `compareEntries` in `lib/server/taskspace-files.ts` settles the same way.
function compareNodes(a: TagNode, b: TagNode): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return byName !== 0 ? byName : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function freezeNodes(nodes: Iterable<MutableNode>): TagNode[] {
  return [...nodes]
    .map((node) => ({
      tag: node.tag,
      name: node.name,
      children: freezeNodes(node.children.values()),
      own: countKeys(node.own),
      total: countKeys(node.total),
    }))
    .sort(compareNodes);
}

/**
 * The hierarchy a flat list of hits describes.
 *
 * Every level of every tag becomes a node, whether or not anyone wrote that level on its
 * own: `'foo:bar` alone still produces a `foo` with no hits of its own and one underneath
 * it, because a tree that skipped it would have no way to draw where `bar` hangs from. That
 * is what `own` and `total` separate — `own` is what was written here, `total` is what
 * selecting this tag on the index page gathers.
 */
export function buildTagTree(hits: TagHit[]): TagNode[] {
  const roots = new Map<string, MutableNode>();

  for (const hit of hits) {
    const key = sourceKey(hit.source);
    const kind = hit.source.kind === "card" ? "cards" : "files";
    const levels = splitTag(hit.tag);
    let siblings = roots;
    let path = "";

    for (const [depth, level] of levels.entries()) {
      path = depth === 0 ? level : `${path}:${level}`;
      let node = siblings.get(level);
      if (!node) {
        node = emptyNode(path, level);
        siblings.set(level, node);
      }
      node.total[kind].add(key);
      if (depth === levels.length - 1) node.own[kind].add(key);
      siblings = node.children;
    }
  }

  return freezeNodes(roots.values());
}

/**
 * One row of a tag listing: the hits drawn on it, and the one source they share.
 *
 * `source` beside `key` rather than only `key`, and that is the whole point of the shape. The
 * key is `card:<id>`, which is a string, and so is the card id it is built from — so a caller
 * that read the identity of a row off its key type-checked, linked to `/card:<id>`, and
 * looked its bundle up under a key nothing holds. The row now carries the thing itself, and
 * the key is only ever what an `{#each}` or a `Map` is keyed by.
 */
export interface TagHitRow<T extends { source: TagSource }> {
  /** {@link hitRowKey}. Unique among the rows of one listing, and nothing else. */
  key: string;
  /** What this row is: the card to open, or the file and line to go and look at. */
  source: T["source"];
  hits: T[];
}

/**
 * Hits gathered under whatever identifies the row they will be drawn on, in first-seen order
 * — which is the order the underlying read produced, so the terminal and the page list them
 * the same way.
 *
 * Keyed by {@link hitRowKey} rather than by a key function each caller passes. The parameter
 * was the only thing the two copies of this had in common, and it was the part they could
 * have got wrong: one row per card, one row per line of a file.
 *
 * Handed a list narrowed by {@link isCardHit} or {@link isFileHit}, every row's `source` is
 * narrowed with it, so drawing one needs no `kind` check at all.
 */
export function groupHitRows<T extends { source: TagSource }>(hits: T[]): TagHitRow<T>[] {
  const rows = new Map<string, TagHitRow<T>>();
  for (const hit of hits) {
    const key = hitRowKey(hit.source);
    const existing = rows.get(key);
    if (existing) existing.hits.push(hit);
    else rows.set(key, { key, source: hit.source, hits: [hit] });
  }
  return [...rows.values()];
}

/** One taskspace's file rows, under the taskspace they are relative to. */
export interface TaskspaceHitGroup<T extends { source: TagSource }> {
  taskspaceId: string;
  rows: TagHitRow<TagHitOf<T, "file">>[];
}

/**
 * File hits gathered under the taskspace each was found in, in first-seen order, and grouped
 * into rows within it.
 *
 * Here for the reason {@link groupHitRows} and {@link hitRowKey} are, and it is the same
 * reason a third time: a path is relative to a taskspace and says nothing on its own — two
 * taskspaces holding a `notes/todo.md` draw two identical rows otherwise — so both listings
 * head their file rows this way, and each had written the grouping out. Two copies of "what
 * is one taskspace's worth of rows" is two chances to answer it differently, in the one place
 * where being wrong looks exactly like being right.
 *
 * Taskspace first and row second, in that order and not the reverse: {@link hitRowKey} is
 * unique across a whole listing, so grouping by row first would produce rows that then have
 * to be re-split by taskspace, and a row can only belong to one.
 */
export function groupHitsByTaskspace<T extends { source: TagSource }>(
  hits: TagHitOf<T, "file">[],
): TaskspaceHitGroup<T>[] {
  const byTaskspace = new Map<string, TagHitOf<T, "file">[]>();
  for (const hit of hits) {
    const existing = byTaskspace.get(hit.source.taskspaceId);
    if (existing) existing.push(hit);
    else byTaskspace.set(hit.source.taskspaceId, [hit]);
  }
  return [...byTaskspace].map(([taskspaceId, group]) => ({
    taskspaceId,
    rows: groupHitRows(group),
  }));
}

/**
 * The distinct tags a row matched by, sigil and all, sorted — so a card found under both
 * `'perf` and `'perf:cache` says which, in one order rather than in whichever the hits
 * happened to arrive in.
 */
export function taggedWith(hits: { tag: string }[]): string[] {
  return [...new Set(hits.map(({ tag }) => `${TAG_SIGIL}${tag}`))].sort();
}

/**
 * What each reason a scan stopped short says to the person reading it.
 *
 * The vocabulary in {@link TagScanTruncation} names the budget that ran out, which is what
 * the scanner needs to say and not what a reader needs to hear: both places that print one —
 * the tag index panel and `kozane tag list` — put it on screen unchanged, so a user was told
 * their notes directory "was not read in full (budget, unreadable)". Here for the same
 * reason the row grouping is: the terminal and the page say the same thing about the same
 * taskspace, so they say it in the same words.
 */
const TRUNCATION_LABELS: Record<TagScanTruncation, string> = {
  entries: "a directory held more entries than one scan lists",
  depth: "some directories sit deeper than the scan goes",
  nodes: "it holds more files and directories than one scan visits",
  budget: "some files were larger than the scan had budget left for",
  "too-large": "some files are larger than one file may be to be read at all",
  unreadable: "some files could not be read",
};

/**
 * Those labels, joined, for a taskspace that stopped at several.
 *
 * Falls back to the raw reason for a value not in the table above. That is not defensive
 * dressing: these cross a serialization boundary — the loader's return becomes the page's
 * `data` — so a reason added on the server and deployed against an older page would
 * otherwise draw `undefined` into the sentence.
 *
 * Read through a partial view of the table, so that fallback is something the types agree
 * can happen. Declared total above and read as partial here, deliberately, because the two
 * ends want opposite things: a new member of {@link TagScanTruncation} must be a compile
 * error at the table, which only a total record gives, while the lookup is of a value that
 * may have come from a build this one does not share a union with — where a total record
 * says the `??` is dead code and invites its removal.
 */
export function truncationReasons(reasons: TagScanTruncation[]): string {
  const labels: Partial<Record<TagScanTruncation, string>> = TRUNCATION_LABELS;
  return reasons.map((reason) => labels[reason] ?? reason).join("; ");
}
