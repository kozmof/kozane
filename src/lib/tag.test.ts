import { describe, expect, it } from "vitest";
import { buildTagTree, normalizeTag, scanTagLines, splitTag, tagMatches } from "./tag";
import { TAG_EXCERPT_CHARS_MAX, TAG_LEVELS_MAX, TAG_SEGMENT_CHARS_MAX } from "./constants";
import type { TagHit } from "./types";

/** The tags of a text, in order, which is what most of the grammar cases are about. */
const tags = (text: string) => scanTagLines(text).map(({ tag }) => tag);

describe("scanTagLines", () => {
  it("finds a plain tag", () => {
    expect(tags("a 'foo tag")).toEqual(["foo"]);
  });

  it("finds a subcategorized tag whole", () => {
    expect(tags("'foo:bar:baz")).toEqual(["foo:bar:baz"]);
  });

  it("finds a tag at the very start of a line", () => {
    expect(tags("'foo leads")).toEqual(["foo"]);
  });

  it("finds a tag opened after a bracket", () => {
    expect(tags("('foo) ['bar] {'baz}")).toEqual(["foo", "bar", "baz"]);
  });

  it("ends a tag at a trailing colon", () => {
    expect(tags("'foo: and on")).toEqual(["foo"]);
  });

  it("leaves an apostrophe inside a word alone", () => {
    expect(tags("don't tag x'foo")).toEqual([]);
  });

  it("leaves a quoted word as text", () => {
    expect(tags("a 'quoted' word")).toEqual([]);
  });

  it("ignores a bare apostrophe with no body", () => {
    expect(tags("'' and ' and ':")).toEqual([]);
  });

  it("finds several tags on one line", () => {
    expect(tags("'perf and 'perf:cache")).toEqual(["perf", "perf:cache"]);
  });

  it("reports a tag written twice on one line only once", () => {
    expect(tags("'foo then 'foo again")).toEqual(["foo"]);
  });

  it("reports the same tag on two lines twice", () => {
    expect(scanTagLines("'foo\n'foo")).toEqual([
      { tag: "foo", line: 1, excerpt: "'foo" },
      { tag: "foo", line: 2, excerpt: "'foo" },
    ]);
  });

  it("normalizes case", () => {
    expect(tags("'Foo:Bar")).toEqual(["foo:bar"]);
  });

  it("tags Japanese text", () => {
    expect(tags("メモ 'こざね:分類 です")).toEqual(["こざね:分類"]);
  });

  it("tags digits and the punctuation the body allows", () => {
    expect(tags("'2024 'a-b 'a_b")).toEqual(["2024", "a-b", "a_b"]);
  });

  it("counts lines from one, across CRLF as well as LF", () => {
    expect(scanTagLines("first\r\nsecond 'foo").map(({ line }) => line)).toEqual([2]);
  });

  it("carries the whole line as the excerpt, trimmed", () => {
    expect(scanTagLines("   padded 'foo line   ")[0].excerpt).toEqual("padded 'foo line");
  });

  it("cuts a long excerpt and marks it", () => {
    const line = `'foo ${"x".repeat(TAG_EXCERPT_CHARS_MAX * 2)}`;
    const { excerpt } = scanTagLines(line)[0];
    expect(excerpt).toHaveLength(TAG_EXCERPT_CHARS_MAX + 1);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("finds nothing in text without a sigil", () => {
    expect(tags("nothing to see here")).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(scanTagLines("")).toEqual([]);
  });

  describe("limits", () => {
    it("takes a level of exactly the maximum length", () => {
      const level = "a".repeat(TAG_SEGMENT_CHARS_MAX);
      expect(tags(`'${level}`)).toEqual([level]);
    });

    it("rejects an over-long level whole rather than cutting it short", () => {
      expect(tags(`'${"a".repeat(TAG_SEGMENT_CHARS_MAX + 1)}`)).toEqual([]);
    });

    it("takes a tag of exactly the maximum depth", () => {
      const tag = Array.from({ length: TAG_LEVELS_MAX }, (_, i) => `l${i}`).join(":");
      expect(tags(`'${tag}`)).toEqual([tag]);
    });

    it("rejects an over-deep tag whole rather than truncating it", () => {
      const tag = Array.from({ length: TAG_LEVELS_MAX + 1 }, (_, i) => `l${i}`).join(":");
      expect(tags(`'${tag}`)).toEqual([]);
    });

    // The bounded body in TAG_RE is what keeps this linear. Unbounded, the lookaheads send
    // the engine back through the whole run at every position.
    it("scans a pathological line without hanging", () => {
      const line = `'${"a".repeat(20_000)}'`;
      const started = Date.now();
      expect(tags(line)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });
});

describe("normalizeTag", () => {
  it("lowercases", () => {
    expect(normalizeTag("FOO:Bar")).toBe("foo:bar");
  });

  it("folds the two spellings of a composed character together", () => {
    expect(normalizeTag("é")).toBe(normalizeTag("é"));
  });
});

describe("splitTag", () => {
  it("splits on the level separator", () => {
    expect(splitTag("foo:bar:baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("gives a single level for a tag with no separator", () => {
    expect(splitTag("foo")).toEqual(["foo"]);
  });
});

describe("tagMatches", () => {
  it("matches itself", () => {
    expect(tagMatches("foo", "foo")).toBe(true);
  });

  it("matches a descendant", () => {
    expect(tagMatches("foo", "foo:bar:baz")).toBe(true);
  });

  it("does not match a tag that merely starts with the same characters", () => {
    expect(tagMatches("foo", "foobar")).toBe(false);
  });

  it("does not match an ancestor", () => {
    expect(tagMatches("foo:bar", "foo")).toBe(false);
  });

  it("ignores case on either side", () => {
    expect(tagMatches("FOO", "foo:Bar")).toBe(true);
  });
});

describe("buildTagTree", () => {
  const cardHit = (tag: string, cardId = "c1"): TagHit => ({
    tag,
    source: { kind: "card", cardId },
    excerpt: tag,
  });
  const fileHit = (tag: string, path = "notes.md"): TagHit => ({
    tag,
    source: { kind: "file", taskspaceId: "t1", path, line: 1 },
    excerpt: tag,
  });

  it("returns nothing for no hits", () => {
    expect(buildTagTree([])).toEqual([]);
  });

  it("nests a subcategory under its parent", () => {
    const [foo] = buildTagTree([cardHit("foo:bar")]);
    expect(foo.tag).toBe("foo");
    expect(foo.children[0].tag).toBe("foo:bar");
    expect(foo.children[0].name).toBe("bar");
  });

  it("creates a parent nobody wrote on its own, with no hits of its own", () => {
    const [foo] = buildTagTree([cardHit("foo:bar")]);
    expect(foo.own).toEqual({ cards: 0, files: 0 });
    expect(foo.total).toEqual({ cards: 1, files: 0 });
  });

  it("counts a parent's own hits apart from its subtree's", () => {
    const [foo] = buildTagTree([
      cardHit("foo", "c1"),
      cardHit("foo:bar", "c2"),
      fileHit("foo:bar:baz"),
    ]);
    expect(foo.own).toEqual({ cards: 1, files: 0 });
    expect(foo.total).toEqual({ cards: 2, files: 1 });
    expect(foo.children[0].total).toEqual({ cards: 1, files: 1 });
  });

  it("counts cards and files separately", () => {
    const [foo] = buildTagTree([cardHit("foo"), fileHit("foo", "a.md"), fileHit("foo", "b.md")]);
    expect(foo.own).toEqual({ cards: 1, files: 2 });
  });

  it("sorts siblings by name at every level", () => {
    const tree = buildTagTree([cardHit("b:z"), cardHit("b:a"), cardHit("a")]);
    expect(tree.map(({ name }) => name)).toEqual(["a", "b"]);
    expect(tree[1].children.map(({ name }) => name)).toEqual(["a", "z"]);
  });

  it("keeps two hits of one tag on one node", () => {
    const tree = buildTagTree([cardHit("foo", "c1"), cardHit("foo", "c2")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].own.cards).toBe(2);
  });

  describe("counts distinct sources, not hits", () => {
    it("counts one card carrying two tags once", () => {
      const [foo] = buildTagTree([cardHit("foo", "c1"), cardHit("foo:bar", "c1")]);
      expect(foo.total.cards).toBe(1);
    });

    it("counts one file tagged on two lines once", () => {
      const twice: TagHit[] = [
        {
          tag: "foo",
          source: { kind: "file", taskspaceId: "t1", path: "a.md", line: 1 },
          excerpt: "",
        },
        {
          tag: "foo",
          source: { kind: "file", taskspaceId: "t1", path: "a.md", line: 9 },
          excerpt: "",
        },
      ];
      expect(buildTagTree(twice)[0].total.files).toBe(1);
    });

    it("counts the same path in two taskspaces separately", () => {
      const both: TagHit[] = [
        {
          tag: "foo",
          source: { kind: "file", taskspaceId: "t1", path: "a.md", line: 1 },
          excerpt: "",
        },
        {
          tag: "foo",
          source: { kind: "file", taskspaceId: "t2", path: "a.md", line: 1 },
          excerpt: "",
        },
      ];
      expect(buildTagTree(both)[0].total.files).toBe(2);
    });
  });
});
