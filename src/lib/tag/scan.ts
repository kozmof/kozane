/** Finding tags in text, with their positions and line excerpts. */
import { TAG_EXCERPT_CHARS_MAX, TAG_SIGIL } from "../constants.js";
import { scanUrls, type UrlSpan } from "../urls.js";
import { TAG_RE, normalizeTag } from "./syntax.js";

/** Tag match with its position in the source text. */
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

/** Tag hit with its source line number and excerpt. */
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
    // Scan each line with the same grammar used to render card tags.
    for (const { tag } of scanTagPositions(line)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      excerpt ??= excerptOf(line);
      hits.push({ tag, line: index + 1, excerpt });
    }
  }

  return hits;
}
