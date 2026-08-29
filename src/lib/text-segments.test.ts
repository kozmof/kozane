import { describe, expect, it } from "vitest";
import { segmentText } from "./text-segments";
import { scanTagLines } from "./tag";

describe("segmentText", () => {
  it("returns a single plain segment when there is no URL", () => {
    expect(segmentText("just some text")).toEqual([{ text: "just some text" }]);
  });

  it("returns an empty array for empty input", () => {
    expect(segmentText("")).toEqual([]);
  });

  it("linkifies a bare URL", () => {
    expect(segmentText("https://example.com")).toEqual([
      { text: "https://example.com", href: "https://example.com" },
    ]);
  });

  it("splits surrounding text from the URL", () => {
    expect(segmentText("see https://example.com now")).toEqual([
      { text: "see " },
      { text: "https://example.com", href: "https://example.com" },
      { text: " now" },
    ]);
  });

  it("leaves trailing sentence punctuation out of the link", () => {
    expect(segmentText("read https://example.com/path.")).toEqual([
      { text: "read " },
      { text: "https://example.com/path", href: "https://example.com/path" },
      { text: "." },
    ]);
  });

  it("linkifies multiple URLs", () => {
    expect(segmentText("http://a.com and http://b.com")).toEqual([
      { text: "http://a.com", href: "http://a.com" },
      { text: " and " },
      { text: "http://b.com", href: "http://b.com" },
    ]);
  });

  it("ignores non-http schemes", () => {
    expect(segmentText("mailto:me@example.com")).toEqual([{ text: "mailto:me@example.com" }]);
  });

  it("keeps query strings and fragments in the link", () => {
    const url = "https://example.com/p?q=1&r=2#frag";
    expect(segmentText(url)).toEqual([{ text: url, href: url }]);
  });

  describe("tags", () => {
    it("marks a tag, keeping the sigil in the text", () => {
      expect(segmentText("about 'perf")).toEqual([
        { text: "about " },
        { text: "'perf", tag: "perf" },
      ]);
    });

    it("marks a subcategorized tag whole", () => {
      expect(segmentText("'foo:bar:baz")).toEqual([{ text: "'foo:bar:baz", tag: "foo:bar:baz" }]);
    });

    it("keeps the text as written while normalizing the tag", () => {
      expect(segmentText("'Perf")).toEqual([{ text: "'Perf", tag: "perf" }]);
    });

    it("splits text around several tags", () => {
      expect(segmentText("a 'one b 'two c")).toEqual([
        { text: "a " },
        { text: "'one", tag: "one" },
        { text: " b " },
        { text: "'two", tag: "two" },
        { text: " c" },
      ]);
    });

    it("leaves an apostrophe that is not a tag as plain text", () => {
      expect(segmentText("don't and 'quoted'")).toEqual([{ text: "don't and 'quoted'" }]);
    });

    it("finds tags on both sides of a URL", () => {
      expect(segmentText("'a https://example.com 'b")).toEqual([
        { text: "'a", tag: "a" },
        { text: " " },
        { text: "https://example.com", href: "https://example.com" },
        { text: " " },
        { text: "'b", tag: "b" },
      ]);
    });

    it("does not find a tag inside a URL", () => {
      const url = "https://example.com/it's/fine";
      expect(segmentText(url)).toEqual([{ text: url, href: url }]);
    });

    it("marks a tag on a later line", () => {
      expect(segmentText("first\n'foo")).toEqual([
        { text: "first\n" },
        { text: "'foo", tag: "foo" },
      ]);
    });
  });
});

/**
 * The invariant the shared grammar exists to hold: what the index gathers from a card and
 * what the card draws as a tag are one decision, not two that happen to agree.
 *
 * They were two. The segmenter matched URLs first and looked for tags only in what was left,
 * while `scanTagLines` read the whole line — so an address holding `('` gathered a card
 * under a tag the card itself did not draw, which is the one disagreement nobody would think
 * to go looking for. Both now step over the spans `lib/urls.ts` finds.
 *
 * Compared as sets: a tag written twice on a line is one hit in the index and two segments on
 * the card, which is each side doing its own job.
 */
describe("agreement with what the index gathers", () => {
  const drawn = (text: string) =>
    [...new Set(segmentText(text).flatMap(({ tag }) => (tag ? [tag] : [])))].sort();
  const gathered = (text: string) => [...new Set(scanTagLines(text).map(({ tag }) => tag))].sort();

  const cases = [
    "plain 'foo text",
    "don't 'quoted' 'til '90s",
    "see https://example.com/('foo)",
    "see https://example.com/it's/fine",
    "see https://example.com 'foo",
    "see https://example.com. 'foo",
    "'foo at https://example.com and 'bar after",
    "'foo\nsecond line 'bar\n'foo again",
    "from 'drizzle-orm' and 'perf:cache",
  ];

  it.each(cases)("draws exactly what it gathers: %j", (text) => {
    expect(drawn(text)).toEqual(gathered(text));
  });
});
