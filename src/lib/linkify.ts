// Splits text into plain and link segments so callers can render URLs as real
// anchors without injecting raw HTML (keeping Svelte's auto-escaping). Only
// http(s) URLs are linkified; trailing sentence punctuation is left as text.
export interface LinkSegment {
  text: string;
  href?: string;
}

const URL_RE = /https?:\/\/[^\s<]+/g;
const TRAILING_PUNCTUATION = /[.,:;!?"')\]}]+$/;

export function linkify(text: string): LinkSegment[] {
  const segments: LinkSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index;
    // Drop trailing punctuation so "see http://x.com." excludes the period; the
    // trimmed characters fall through to the next plain-text slice below.
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (start > lastIndex) segments.push({ text: text.slice(lastIndex, start) });
    segments.push({ text: url, href: url });
    lastIndex = start + url.length;
  }

  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  return segments;
}
