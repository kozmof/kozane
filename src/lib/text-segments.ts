import { scanTagPositions } from "./tag.js";
import { scanUrls } from "./urls.js";

// Splits text into plain, link, and tag segments so callers can render URLs as real anchors
// and tags as real links without injecting raw HTML (keeping Svelte's auto-escaping). Only
// http(s) URLs are linkified; trailing sentence punctuation is left as text.
export interface TextSegment {
  text: string;
  /** Set on a URL segment: where the link goes. */
  href?: string;
  /** Set on a tag segment: the normalized tag, without its sigil. The `text` still carries
   *  the tag as it was written, sigil and all, so a card reads as it was typed. */
  tag?: string;
}

/**
 * Tag segments within one run of plain text.
 *
 * The tags come from `scanTagPositions`, which is the same grammar the tag index gathers by,
 * so a tag drawn on a card and a tag the index finds are one decision rather than two. A
 * card highlighting something the index did not gather — or gathering something it did not
 * highlight — is exactly the disagreement nobody thinks to check for.
 */
function tagSegments(text: string): TextSegment[] {
  const positions = scanTagPositions(text);
  if (positions.length === 0) return text ? [{ text }] : [];

  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const { tag, index, length } of positions) {
    if (index > cursor) segments.push({ text: text.slice(cursor, index) });
    segments.push({ text: text.slice(index, index + length), tag });
    cursor = index + length;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

export function segmentText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  // URLs first, and tags only within what is left. A URL may hold an apostrophe, and a path
  // inside one is not a tag someone wrote — matching tags first would break the link around
  // it. The other order costs nothing, because the grammar does not read a tag inside a URL
  // either: `scanUrls` is where both this and `scanTagPositions` get their spans, so the
  // segment drawn as a link and the span the grammar steps over are one decision.
  for (const { url, index: start } of scanUrls(text)) {
    if (start > lastIndex) segments.push(...tagSegments(text.slice(lastIndex, start)));
    segments.push({ text: url, href: url });
    // Trailing punctuation is not part of the URL, so the characters between here and the
    // next span fall through to the plain-text slice below — where "see http://x.com. 'foo"
    // still finds its tag.
    lastIndex = start + url.length;
  }

  if (lastIndex < text.length) segments.push(...tagSegments(text.slice(lastIndex)));
  return segments;
}
