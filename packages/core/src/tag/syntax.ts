/** What a tag is: its syntax, normal form, and matching. */
import { TAG_LEVELS_MAX, TAG_SEGMENT_CHARS_MAX, TAG_SIGIL } from "../constants/tag.js";

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
export const TAG_RE = new RegExp(
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
