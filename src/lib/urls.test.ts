import { describe, expect, it } from "vitest";
import { scanUrls } from "./urls";

/**
 * `scanUrls` is the module both readings of a text agree through: `lib/tag.ts` cuts these
 * spans out of the grammar and `lib/text-segments.ts` draws them as anchors. It was covered
 * only through those two, which is coverage of the agreement rather than of the rule — the
 * span boundaries are what both of them depend on, and a trim that moved by one character
 * would show up as a tag appearing or vanishing several modules away.
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

  // The trim is what makes "see http://x.com." link the address and leave the period as
  // prose — and it moves where the span ends, which is the boundary a tag written after it
  // is read against.
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

  // The trim can never empty a match — every one of them opens with a scheme, and `/` is not
  // trailing punctuation — so a bare scheme is a span like any other rather than the
  // zero-width one the guard in `scanUrls` stands against. Pinned because that is the
  // property the guard rests on: if the pattern ever matched something the trim could consume
  // whole, this is the test that would say so.
  it("keeps a bare scheme, which the trim cannot empty", () => {
    // A scheme with nothing after it is not a match at all — the pattern wants at least one
    // character past `://`.
    expect(scanUrls("http://")).toEqual([]);
    // With one, it matches; the trim then takes that character and leaves the scheme, which
    // is the closest this gets to the empty span the guard stands against.
    expect(spansOf("http://.")).toEqual([["http://", 0]]);
  });

  it("ends a url at whitespace and at a left angle bracket", () => {
    expect(spansOf("http://example.com/a b")).toEqual([["http://example.com/a", 0]]);
    expect(spansOf("<http://example.com/a>text")).toEqual([["http://example.com/a>text", 1]]);
  });

  // The `://` guard is claimed to be exact rather than approximate: every match of the
  // pattern contains it, so the fast path can never skip a url the slow path would find.
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
