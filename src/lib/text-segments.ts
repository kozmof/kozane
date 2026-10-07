import { scanTagPositions } from "./tag.js";
import { scanUrls } from "./urls.js";

// Split text into plain, HTTP(S) link, and tag segments for escaped rendering. Leave trailing
// sentence punctuation as plain text.
export interface TextSegment {
  text: string;
  /** Link destination for a URL segment. */
  href?: string;
  /**
   * Normalized tag without its sigil. `text` preserves the original spelling and sigil for
   * display.
   */
  tag?: string;
}

/** One thing to be drawn as itself rather than as plain text, and where it sits. */
type Span = { index: number; length: number; text: string; href?: string; tag?: string };

/**
 * Merge URL and tag spans into display segments. Pass shared URL spans to the tag scanner so
 * rendered links and indexed tags use the same boundaries and cannot overlap.
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
    // Preserve punctuation between spans as plain text.
    if (index > cursor) segments.push({ text: text.slice(cursor, index) });
    segments.push(href ? { text: span, href } : { text: span, tag });
    cursor = index + length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
