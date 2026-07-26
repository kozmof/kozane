import { describe, expect, it } from "vitest";
import { linkify } from "./linkify";

describe("linkify", () => {
  it("returns a single plain segment when there is no URL", () => {
    expect(linkify("just some text")).toEqual([{ text: "just some text" }]);
  });

  it("returns an empty array for empty input", () => {
    expect(linkify("")).toEqual([]);
  });

  it("linkifies a bare URL", () => {
    expect(linkify("https://example.com")).toEqual([
      { text: "https://example.com", href: "https://example.com" },
    ]);
  });

  it("splits surrounding text from the URL", () => {
    expect(linkify("see https://example.com now")).toEqual([
      { text: "see " },
      { text: "https://example.com", href: "https://example.com" },
      { text: " now" },
    ]);
  });

  it("leaves trailing sentence punctuation out of the link", () => {
    expect(linkify("read https://example.com/path.")).toEqual([
      { text: "read " },
      { text: "https://example.com/path", href: "https://example.com/path" },
      { text: "." },
    ]);
  });

  it("linkifies multiple URLs", () => {
    expect(linkify("http://a.com and http://b.com")).toEqual([
      { text: "http://a.com", href: "http://a.com" },
      { text: " and " },
      { text: "http://b.com", href: "http://b.com" },
    ]);
  });

  it("ignores non-http schemes", () => {
    expect(linkify("mailto:me@example.com")).toEqual([{ text: "mailto:me@example.com" }]);
  });

  it("keeps query strings and fragments in the link", () => {
    const url = "https://example.com/p?q=1&r=2#frag";
    expect(linkify(url)).toEqual([{ text: url, href: url }]);
  });
});
