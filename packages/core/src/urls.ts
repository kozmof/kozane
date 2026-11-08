/**
 * Find shared HTTP(S) URL spans for tag exclusion and link rendering. Keep the rule
 * independent of either caller so both use identical boundaries.
 */

/**
 * A URL and its text offset. `url.length` excludes trailing punctuation removed by the
 * scanner.
 */
export interface UrlSpan {
  url: string;
  /** Offset of the first character of `url` in the text as given. */
  index: number;
}

const URL_RE = /https?:\/\/[^\s<]+/g;

/**
 * Trailing sentence punctuation excluded from URL spans. Share trimming so tag and link
 * boundaries agree.
 */
const TRAILING_PUNCTUATION = /[.,:;!?"')\]}]+$/;

/**
 * Return URL spans with trailing punctuation removed. Skip the regex when `://` is absent
 * because no URL can match.
 */
export function scanUrls(text: string): UrlSpan[] {
  const spans: UrlSpan[] = [];
  if (!text.includes("://")) return spans;

  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    // Reject empty spans even if a future pattern allows trimming a match completely.
    if (url) spans.push({ url, index: match.index });
  }
  return spans;
}
