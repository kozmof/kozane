import { describe, expect, it } from "vitest";
import { scanUrls } from "./urls";

/**
 * Test URL span boundaries directly because tag scanning and link rendering both depend on
 * them.
 */
describe("scanUrls", () => {
  const spansOf = (text: string) => scanUrls(text).map(({ url, index }) => [url, index]);

  it("finds nothing in a text with no scheme", () => {
    expect(scanUrls("plain prose about example.com and 'tags")).toEqual([]);
  });

  it("reports the offset of the url in the text as given", () => {
    expect(spansOf("see http://example.com now")).toEqual([["http://example.com", 4]]);
  });

  it("reads https as well as http", () => {
    expect(spansOf("https://example.com")).toEqual([["https://example.com", 0]]);
  });

  it("finds every url in one text, in order", () => {
    expect(spansOf("http://a.example and https://b.example")).toEqual([
      ["http://a.example", 0],
      ["https://b.example", 21],
    ]);
  });

  // Trim sentence punctuation from links while preserving it in surrounding prose.
  it("leaves trailing sentence punctuation out of the url", () => {
    expect(spansOf("see http://example.com.")).toEqual([["http://example.com", 4]]);
    expect(spansOf("(http://example.com)")).toEqual([["http://example.com", 1]]);
    expect(spansOf('"http://example.com",')).toEqual([["http://example.com", 1]]);
    expect(spansOf("http://example.com!?")).toEqual([["http://example.com", 0]]);
  });

  it("keeps punctuation that is inside the url rather than after it", () => {
    expect(spansOf("http://example.com/a.b/c?d=1&e=2#f")).toEqual([
      ["http://example.com/a.b/c?d=1&e=2#f", 0],
    ]);
  });

  // Verify that punctuation trimming cannot consume a complete URL match. The remaining
  // scheme prevents a zero-width span.
  it("keeps a bare scheme, which the trim cannot empty", () => {
    // A scheme alone does not match because the pattern requires a character after `://`.
    expect(scanUrls("http://")).toEqual([]);
    // A punctuation-only suffix can match, then trim back to the scheme.
    expect(spansOf("http://.")).toEqual([["http://", 0]]);
  });

  it("ends a url at whitespace and at a left angle bracket", () => {
    expect(spansOf("http://example.com/a b")).toEqual([["http://example.com/a", 0]]);
    expect(spansOf("<http://example.com/a>text")).toEqual([["http://example.com/a>text", 1]]);
  });

  // Every URL pattern match must contain `://` so the fast path cannot skip a valid match.
  it("does not skip a url that the pattern would have matched", () => {
    for (const text of ["http://x", "https://x", "a\nhttp://x", "…http://x"]) {
      expect(scanUrls(text).length).toBe(1);
    }
  });

  it("is not confused by a bare scheme-like word", () => {
    expect(scanUrls("http and https are schemes")).toEqual([]);
    expect(scanUrls("ftp://example.com")).toEqual([]);
  });

  // `scanTagMatches` builds the gaps between spans in one pass on the promise that they are
  // disjoint and ascending. Nothing else checks it.
  it("returns disjoint spans in ascending order", () => {
    const spans = scanUrls("a http://one.example b https://two.example c http://three.example");
    const ends = spans.map(({ url, index }) => index + url.length);
    expect(spans.map(({ index }) => index)).toEqual([2, 23, 45]);
    for (const [i, { index }] of spans.entries()) {
      if (i > 0) expect(index).toBeGreaterThanOrEqual(ends[i - 1]);
    }
  });
});
