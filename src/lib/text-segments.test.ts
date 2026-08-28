import { describe, expect, it } from "vitest";
import { segmentText } from "./text-segments";

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
