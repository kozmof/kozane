/**
 * Where the http(s) URLs in a text are.
 *
 * A leaf module of its own, and it has to be one, because two modules need the same answer
 * and neither can own it. `lib/tag.ts` cuts these spans out of the tag grammar — a tag inside
 * a link is part of an address, not a label anyone wrote — and `lib/text-segments.ts` draws
 * the same spans as anchors. The segmenter is built on the grammar, so the import arrow can
 * only point one way, and putting the rule in either of them would leave the other with a
 * second copy of it.
 *
 * Two copies is what there was, and the divergence was real rather than theoretical: the
 * segmenter matched URLs first and scanned tags only in what was left, while the scanner
 * behind the index read the whole line. A URL holding `('` therefore gathered a card under a
 * tag the card itself did not draw — the one disagreement the shared grammar exists to make
 * impossible.
 *
 * Sharing the module was not by itself enough to make it impossible, which is worth writing
 * down because it looked as though it were. Both ends read these spans, but one *cut* at them
 * and the other only asked whether a match had started inside one — so a tag running into an
 * address (`'todo:https://x.com`) still parted the two. Both now cut, and the segmenter is
 * handed the spans the grammar cut by rather than finding its own.
 */

/** One URL, and where it sits in the text it was found in. `url.length` is its extent: the
 *  trailing punctuation trimmed below is not part of it. */
export interface UrlSpan {
  url: string;
  /** Offset of the first character of `url` in the text as given. */
  index: number;
}

const URL_RE = /https?:\/\/[^\s<]+/g;

/**
 * Sentence punctuation that ends a URL rather than belonging to it, so "see http://x.com."
 * links `http://x.com` and leaves the period as text. Trimmed here rather than by each
 * caller, because it moves where the span ends — and a tag written after that period has to
 * be read against the same boundary the anchor was drawn to.
 */
const TRAILING_PUNCTUATION = /[.,:;!?"')\]}]+$/;

/**
 * Every URL in a text, trailing punctuation removed.
 *
 * The guard is exact rather than approximate: every match of {@link URL_RE} contains `://`,
 * so a text without one holds no URL, and the common case — a card of prose, a line of a
 * file — costs one substring search instead of a regex pass.
 */
export function scanUrls(text: string): UrlSpan[] {
  const spans: UrlSpan[] = [];
  if (!text.includes("://")) return spans;

  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    // Nothing left once the punctuation went. Nothing to link and nothing to exclude, and
    // an empty span would be a zero-width region every offset test has to special-case.
    if (url) spans.push({ url, index: match.index });
  }
  return spans;
}
