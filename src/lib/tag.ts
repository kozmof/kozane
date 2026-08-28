import {
  TAG_EXCERPT_CHARS_MAX,
  TAG_LEVELS_MAX,
  TAG_SEGMENT_CHARS_MAX,
  TAG_SIGIL,
} from "./constants.js";
import type { TagHit, TagSource } from "./types.js";

/**
 * The tag grammar, in one place, for every caller: a card's text, a taskspace file's text,
 * the CLI, and the browser. A leaf module like `linkify.ts` — nothing here reaches the
 * database or the filesystem, which is what lets `src/cli` (built by `tsc`), the server, and
 * the board all read tags by the same rules rather than by three that agree for now.
 *
 * A tag is `'foo`, and subcategorizes as `'foo:bar:baz`:
 *
 * ```
 * sigil     '   preceded by start-of-line, whitespace, or an opening ( [ {
 * body      segment ( ":" segment )*
 * segment   [\p{L}\p{N}_-]+
 * ```
 *
 * The sigil is an apostrophe, which ordinary prose also uses, so two rules keep writing from
 * becoming tagging:
 *
 * - **A word boundary opens it.** `don't` and `x'foo` are words with an apostrophe in them,
 *   not tags.
 * - **A closing apostrophe cancels it.** `'quoted'` is a quoted word, so it is left as text.
 *
 * The second rule reaches one token, and deliberately: `'a phrase'` still tags `a`, because
 * deciding otherwise means scanning ahead for a closing quote that may be on another line,
 * or may be an apostrophe in a word, and guessing wrong in either direction is worse than
 * the small amount of noise this leaves. A tag nobody meant is one row in the index; a tag
 * silently swallowed is a card that cannot be found.
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
 * What was actually typed is not lost — every hit carries the line it sits on.
 */
export function normalizeTag(tag: string): string {
  return tag.normalize("NFC").toLowerCase();
}

/** The levels of a tag, outermost first: `foo:bar:baz` is `["foo", "bar", "baz"]`. */
export function splitTag(tag: string): string[] {
  return tag.split(":");
}

/**
 * Whether `tag` is `query` or sits under it. Prefix by level, not by character, which is the
 * whole point of subcategories: `foo` gathers `foo:bar:baz`, and does not gather `foobar`.
 */
export function tagMatches(query: string, tag: string): boolean {
  const q = normalizeTag(query);
  const t = normalizeTag(tag);
  return t === q || t.startsWith(`${q}:`);
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
 */
export function scanTagPositions(text: string): TagPosition[] {
  const positions: TagPosition[] = [];
  if (!text.includes(TAG_SIGIL)) return positions;

  for (const match of text.matchAll(TAG_RE)) {
    positions.push({
      tag: normalizeTag(match[1]),
      index: match.index,
      length: match[0].length,
    });
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

function excerptOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > TAG_EXCERPT_CHARS_MAX
    ? `${trimmed.slice(0, TAG_EXCERPT_CHARS_MAX)}…`
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
    for (const match of line.matchAll(TAG_RE)) {
      const tag = normalizeTag(match[1]);
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
 */
export function sourceKey(source: TagSource): string {
  return source.kind === "card"
    ? `card:${source.cardId}`
    : `file:${source.taskspaceId}:${source.path}`;
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
 */
type MutableNode = Omit<TagNode, "children" | "own" | "total"> & {
  children: Map<string, MutableNode>;
  own: Set<string>;
  total: Set<string>;
};

function emptyNode(tag: string, name: string): MutableNode {
  return { tag, name, children: new Map(), own: new Set(), total: new Set() };
}

function countKeys(keys: Set<string>): TagCounts {
  let cards = 0;
  let files = 0;
  for (const key of keys) {
    if (key.startsWith("card:")) cards++;
    else files++;
  }
  return { cards, files };
}

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
      node.total.add(key);
      if (depth === levels.length - 1) node.own.add(key);
      siblings = node.children;
    }
  }

  return freezeNodes(roots.values());
}
