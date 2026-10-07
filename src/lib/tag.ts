import {
  TAG_EXCERPT_CHARS_MAX,
  TAG_LEVELS_MAX,
  TAG_SEGMENT_CHARS_MAX,
  TAG_SIGIL,
} from "./constants.js";
import type { TagHit, TagScanTruncation, TagSource } from "./types.js";
import { scanUrls, type UrlSpan } from "./urls.js";

/**
 * Use one tag grammar for card text, taskspace files, the CLI, and the browser. This module has
 * no database or filesystem dependencies. It also supplies the shared grouping and display
 * helpers.
 *
 * A tag starts with `:` at the start of text, after whitespace, or after an opening `(`, `[`,
 * or `{`. Each segment contains Unicode letters, numbers, underscores, or hyphens. Colons
 * separate levels, so `:foo:bar:baz` has the body `foo:bar:baz`.
 *
 * Ordinary punctuation such as `12:30` and `key: value` does not open a tag. URL spans are
 * excluded before scanning, using `lib/urls.ts`, so a tag cannot start inside or continue into
 * a URL. The index and renderer use this same boundary rule.
 *
 * A trailing colon does not cancel a tag. `:foo:` contains the tag `foo` followed by
 * punctuation.
 *
 * The grammar applies uniformly to every source. Symbol literals such as `:active` and
 * emoticons such as `:D` can therefore become tags. The file scanner skips generated and
 * dependency directories listed in `TAG_SCAN_SKIP_DIRS`, but does not apply language-specific
 * exclusions to handwritten source.
 */

// Bound segment length and depth in the regex to reject oversized tags and limit backtracking
// when trailing lookaheads fail.
const SEGMENT = String.raw`[\p{L}\p{N}_-]{1,${TAG_SEGMENT_CHARS_MAX}}`;

/**
 * Reject oversized tag candidates instead of accepting a truncated prefix.
 *
 * The first trailing lookahead requires the segment to end on its own. The second rejects a
 * remaining colon followed by another segment. A trailing colon without a segment remains
 * valid punctuation.
 */
const TAG_RE = new RegExp(
  String.raw`(?<=^|[\s(\[{])${TAG_SIGIL}(${SEGMENT}(?::${SEGMENT}){0,${TAG_LEVELS_MAX - 1}})` +
    String.raw`(?![\p{L}\p{N}_-])(?!:[\p{L}\p{N}_-])`,
  "gu",
);

/**
 * Normalize tag keys by lowercasing, then applying NFC. This merges canonically equivalent
 * spellings while keeping the original text in each hit's line.
 *
 * NFC preserves width distinctions, so `:Ｆｏｏ` and `:Foo` remain separate tags, as do `:ｱｲｳ` and
 * `:アイウ`. NFKC would merge these but would also merge other compatibility characters. A future
 * width-only normalization should address that case separately.
 *
 * Normalize after lowercasing so the resulting key is in NFC even when lowercasing changes its
 * character sequence.
 */
export function normalizeTag(tag: string): string {
  return tag.toLowerCase().normalize("NFC");
}

/** Tag levels from outermost to innermost. `foo:bar:baz` becomes `["foo", "bar", "baz"]`. */
export function splitTag(tag: string): string[] {
  return tag.split(":");
}

/**
 * Match a normalized tag to a query or its descendants by complete levels. `foo` matches
 * `foo:bar` but not `foobar`. The query need not be normalized.
 */
export function tagMatches(query: string, tag: string): boolean {
  return tagMatcher(query)(tag);
}

/**
 * Normalize the query once and return a matcher for repeated comparisons. Input tags must
 * already be normalized, as scanner-produced tags are.
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
 * Return tag positions in the original text for rendering. Keep source offsets because
 * normalization can change text length. Reuse supplied URL spans or scan them when omitted.
 */
export function scanTagPositions(text: string, urls?: UrlSpan[]): TagPosition[] {
  // Skip tag and URL scanning when the text contains no sigil.
  if (!text.includes(TAG_SIGIL)) return [];
  return scanTagMatches(text, urls ?? scanUrls(text));
}

/**
 * Scan tags only in the gaps between URL spans so tags cannot start inside or continue into
 * an address. Return offsets in the original text for all callers.
 */
function scanTagMatches(text: string, urls: UrlSpan[]): TagPosition[] {
  const positions: TagPosition[] = [];

  // Process gaps between ordered, nonoverlapping URL spans. Without URLs, scan the full text
  // as one gap.
  const gaps: [number, number][] = [];
  let start = 0;
  for (const { url, index } of urls) {
    if (index > start) gaps.push([start, index]);
    start = index + url.length;
  }
  if (start < text.length) gaps.push([start, text.length]);

  for (const [from, to] of gaps) {
    // Scan each gap as its own string so lookbehind treats its first character as a new text
    // boundary, independent of the preceding URL.
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
  /** Normalized tag without its sigil, such as `foo:bar:baz`. */
  tag: string;
  /** 1-based, counting the lines of the text as given. */
  line: number;
  /** The line the tag sits on, trimmed and cut to {@link TAG_EXCERPT_CHARS_MAX}. */
  excerpt: string;
}

/**
 * Trim an excerpt to {@link TAG_EXCERPT_CHARS_MAX} code points without splitting surrogate
 * pairs. Use code-unit length as a fast check before expanding longer strings.
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
 * Find tags and their line numbers in card or file text. Callers attach their own
 * `TagSource`. Report repeated occurrences of the same tag on one line only once.
 */
export function scanTagLines(text: string): TagLineHit[] {
  const hits: TagLineHit[] = [];
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    // Skip lines without colons because they cannot contain tags.
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
 * Identify the source card or file for distinct counts, regardless of matched tag or line.
 * Use {@link hitRowKey} separately for displayed rows.
 */
export function sourceKey(source: TagSource): string {
  return source.kind === "card"
    ? `card:${source.cardId}`
    : `file:${source.taskspaceId}:${source.path}`;
}

/**
 * Identify one display row per card or per file line. Share this grouping rule between CLI
 * and browser listings.
 */
export function hitRowKey(source: TagSource): string {
  return source.kind === "card"
    ? `card:${source.cardId}`
    : `file:${source.taskspaceId}:${source.path}:${source.line}`;
}

/**
 * Narrow hits by source so filtered arrays expose the corresponding source fields. See {@link
 * groupHitRows}.
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
 * Filter, count, and cap hits in one pass. Keep separate limits for cards and file lines so
 * neither kind excludes the other. Apply optional `keep` filtering before counting and avoid
 * allocating uncapped result arrays.
 */
export function capHitsByKind<T extends { source: TagSource }>(
  hits: T[],
  max: number,
  keep?: (hit: T) => boolean,
): CappedHits<T> {
  const cards: TagHitOf<T, "card">[] = [];
  const files: TagHitOf<T, "file">[] = [];
  let cardTotal = 0;
  let fileTotal = 0;

  for (const hit of hits) {
    if (keep && !keep(hit)) continue;
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
 * Count distinct cards and files per {@link sourceKey}, keeping the two source kinds
 * separate.
 */
export interface TagCounts {
  cards: number;
  files: number;
}

/** One node of the tag hierarchy the index page draws. */
export interface TagNode {
  /** Full path to this node, such as `foo:bar`, used in links. */
  tag: string;
  /** This node's level, such as `bar`, displayed beside its siblings. */
  name: string;
  children: TagNode[];
  /** Hits whose tag is exactly this node. */
  own: TagCounts;
  /** Hits on this node and its descendants, matching `tagMatches` behavior. */
  total: TagCounts;
}

/**
 * Accumulate distinct source sets by kind while building tree counts. Adding numeric counts
 * would double-count sources matching several descendant tags.
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
 * Build every level of the tag hierarchy, including unwritten ancestors. `own` counts hits at
 * the exact node, while `total` includes descendants.
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
 * Display row with grouped hits and their shared source identity. Use `key` only for row
 * bookkeeping, and read actual card or file identity from `source`.
 */
export interface TagHitRow<T extends { source: TagSource }> {
  /** {@link hitRowKey}. Unique among the rows of one listing, and nothing else. */
  key: string;
  /** The card or file and line that this row opens. */
  source: T["source"];
  hits: T[];
}

/**
 * Group hits by {@link hitRowKey} in first-seen order. Preserve narrowed source types for
 * card-only or file-only inputs.
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
 * Group file hits by taskspace, then by display row, preserving first-seen order. Taskspace
 * headings distinguish identical relative paths.
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

/** Sorted distinct tags matched by a row, including their sigils. */
export function taggedWith(hits: { tag: string }[]): string[] {
  return [...new Set(hits.map(({ tag }) => `${TAG_SIGIL}${tag}`))].sort();
}

/** Shared reader-facing labels for scan truncation reasons used by the CLI and tag page. */
const TRUNCATION_LABELS: Record<TagScanTruncation, string> = {
  entries: "a directory held more entries than one scan lists",
  depth: "some directories sit deeper than the scan goes",
  nodes: "it holds more files and directories than one scan visits",
  budget: "some files were larger than the scan had budget left for",
  hits: "it holds more tags than one scan gathers, so the counts above are a floor",
  "too-large": "some files are larger than one file may be to be read at all",
  unreadable: "some files could not be read",
};

/**
 * Join truncation labels with fallback wording for unknown serialized values. Declare the
 * label table exhaustively but allow missing lookups at this boundary so older clients handle
 * newer reasons.
 */
export function truncationReasons(reasons: TagScanTruncation[]): string {
  const labels: Partial<Record<TagScanTruncation, string>> = TRUNCATION_LABELS;
  return reasons.map((reason) => labels[reason] ?? UNKNOWN_TRUNCATION_LABEL).join("; ");
}

/** What is said about a reason this build has no wording for. See {@link truncationReasons}. */
const UNKNOWN_TRUNCATION_LABEL = "some of it was not read, for a reason this page cannot name";

/** Shared message for card-hit truncation, separate from taskspace scan limits. */
export const CARDS_TRUNCATED_LABEL =
  "more cards carry tags than one gather reads, so the counts above are a floor";

/**
 * Describe an unavailable taskspace by name. Keep this separate from partial-scan labels
 * because its root was not read at all.
 */
export const missingTaskspaceLabel = (name: string): string =>
  `${name} could not be read — its directory has been deleted, moved, or made unreadable since the record naming it was written, so no tag written in it is listed here`;

/**
 * Shared taskspace repair command and surrounding text. Keep them separate so the terminal
 * and page can format the command differently.
 */
export const TASKSPACE_CLEANUP_COMMAND = "kozane taskspace scan --apply --cleanup";

/** What follows {@link TASKSPACE_CLEANUP_COMMAND} in that instruction. Plural because one
 *  gather can meet several such records, and one run of the command settles all of them. */
export const cleanupCommandTail = (count: number): string =>
  count === 1 ? "to drop the record." : "to drop the records.";

/**
 * Format a sample of affected paths, or return an empty phrase when none are supplied. Accept
 * absent path lists from older serialized results.
 */
export function truncationPaths(paths: string[] | undefined): string {
  if (!paths || paths.length === 0) return "";
  return ` (for example ${paths.join(", ")})`;
}
