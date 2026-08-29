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

/** One thing to be drawn as itself rather than as plain text, and where it sits. */
type Span = { index: number; length: number; text: string; href?: string; tag?: string };

/**
 * A card's text, cut into what it is made of.
 *
 * Both kinds of span come from one scan of one text: `scanUrls` finds the addresses, and
 * `scanTagPositions` is handed those very spans so the tags it finds are the tags the index
 * gathers — the grammar cuts URLs out, so nothing it returns can overlap one, and the two
 * lists merge by position without a rule for what to do when they collide.
 *
 * It used to cut at the URLs first and re-scan each remaining piece for tags, which is where
 * the two readings of a card diverged: a piece's first character looked like the start of a
 * text to the segmenter and like the middle of one to the index, so `see 'http://x.com'` was
 * drawn with no tag and gathered under `http`. The cut belongs to the grammar now, and this
 * asks it rather than repeating it. See the URL rule in `lib/tag.ts`.
 */
export function segmentText(text: string): TextSegment[] {
  const urls = scanUrls(text);
  const spans: Span[] = [
    ...urls.map(({ url, index }) => ({ index, length: url.length, text: url, href: url })),
    ...scanTagPositions(text, urls).map(({ tag, index, length }) => ({
      index,
      length,
      text: text.slice(index, index + length),
      tag,
    })),
  ].sort((a, b) => a.index - b.index);

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const { index, length, text: span, href, tag } of spans) {
    // Trailing punctuation is not part of a URL, so the characters between one span and the
    // next fall through here as plain text — which is where "see http://x.com. 'foo" gets
    // its period back.
    if (index > cursor) segments.push({ text: text.slice(cursor, index) });
    segments.push(href ? { text: span, href } : { text: span, tag });
    cursor = index + length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
