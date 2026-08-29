import { describe, expect, it } from "vitest";
import {
  buildTagTree,
  capHitsByKind,
  groupHitRows,
  isCardHit,
  isFileHit,
  normalizeTag,
  scanTagLines,
  splitTag,
  taggedWith,
  tagMatcher,
  tagMatches,
  truncationReasons,
} from "./tag";
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

  /**
   * Cut by character, not by UTF-16 code unit. Slicing by unit through an astral character
   * leaves half of one at the end, and the excerpt is not transient — it is written into
   * `.kozane/tag-index.json` and read back — so the half character is drawn as `�` from then
   * on. The emoji is placed to straddle the cut exactly.
   */
  it("cuts a long excerpt without splitting a character in half", () => {
    // The emoji is the 200th character and the 200th and 201st code units, so a cut by unit
    // lands inside it and a cut by character lands after it.
    const line = `'foo ${"x".repeat(TAG_EXCERPT_CHARS_MAX - 6)}\u{1F600}${"y".repeat(20)}`;
    const { excerpt } = scanTagLines(line)[0];

    expect([...excerpt]).toHaveLength(TAG_EXCERPT_CHARS_MAX + 1);
    expect(excerpt.endsWith("\u{1F600}…")).toBe(true);
  });

  it("finds nothing in text without a sigil", () => {
    expect(tags("nothing to see here")).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(scanTagLines("")).toEqual([]);
  });

  /**
   * A URL is an address, not text someone wrote a tag in. The bracket cases are the ones
   * that matter: the pattern opens a tag after `(` or `[`, both of which are legal inside a
   * URL, so without the span rule an address gathered a card under a tag the card did not
   * draw — the renderer having always treated the URL as one piece.
   */
  describe("URLs", () => {
    it("leaves an apostrophe inside a URL alone", () => {
      expect(tags("see https://example.com/it's/fine")).toEqual([]);
    });

    it("leaves one opened after a bracket inside a URL alone", () => {
      expect(tags("see https://example.com/('foo)")).toEqual([]);
    });

    it("still finds a tag written beside a URL", () => {
      expect(tags("see https://example.com 'foo")).toEqual(["foo"]);
    });

    /** Trailing punctuation is not part of the URL, on either side of the grammar, so a tag
     *  after the sentence's full stop is still a tag. */
    it("still finds a tag after a URL that ended a sentence", () => {
      expect(tags("see https://example.com. 'foo")).toEqual(["foo"]);
    });

    it("finds a tag on a line whose URL comes after it", () => {
      expect(tags("'foo at https://example.com")).toEqual(["foo"]);
    });

    /**
     * A URL ends whatever was being written into it, because its characters are cut out
     * before the pattern sees them rather than merely skipped once it has matched.
     *
     * Skipping tested where a match *began*, which let a candidate that opened in prose and
     * ran into an address through whole: the tag reached past the `://` and took part of the
     * host with it. Both cases below were real, and both produced a tag the card did not draw
     * — the renderer having always cut.
     */
    it("ends a tag at the URL it runs into, rather than reading through it", () => {
      expect(tags("'todo:https://example.com/issue/1")).toEqual(["todo"]);
      expect(tags("notes 'refhttps://x.com")).toEqual(["ref"]);
    });

    /** The other half of the same rule: with nothing but the sigil left in front of the
     *  address, there is no tag at all. Quoting a URL used to put `http` in the tree of every
     *  workspace where anyone did it. */
    it("reads a quoted URL as no tag, not as 'http", () => {
      expect(tags("see 'http://example.com'")).toEqual([]);
      expect(tags("read 'https://docs.example.com later")).toEqual([]);
    });

    /** A URL is a boundary, not a joiner: what follows one starts a text of its own, and an
     *  apostrophe there opens a tag only if the characters between say it may. */
    it("does not let a URL's last character open a tag after it", () => {
      expect(tags("(https://x.com)'foo")).toEqual([]);
      expect(tags("https://x.com/'foo")).toEqual([]);
    });
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

describe("tagMatcher", () => {
  it("answers as tagMatches does, with the query read once", () => {
    const matches = tagMatcher("Foo");
    expect([matches("foo"), matches("foo:bar"), matches("foobar")]).toEqual([true, true, false]);
  });
});

describe("groupHitRows", () => {
  const cardHit = (cardId: string, tag: string): TagHit => ({
    tag,
    source: { kind: "card", cardId },
    excerpt: "",
  });
  const fileHit = (path: string, line: number, tag: string): TagHit => ({
    tag,
    source: { kind: "file", taskspaceId: "t1", path, line },
    excerpt: "",
  });

  it("puts every hit on one card in one row", () => {
    const rows = groupHitRows([cardHit("c1", "perf"), cardHit("c1", "perf:cache")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].hits).toHaveLength(2);
  });

  // The row has to carry the card, not only a key built from it: a caller reading the
  // identity of a row off its key gets `card:c1`, which is a string like an id is a string
  // and so links to a board that does not exist.
  it("carries the source a row is, beside the key it is drawn under", () => {
    const [row] = groupHitRows([cardHit("c1", "perf")]);
    expect(row.key).toBe("card:c1");
    expect(row.source).toEqual({ kind: "card", cardId: "c1" });
  });

  it("carries the file and line for a file row", () => {
    const [row] = groupHitRows([fileHit("a.md", 9, "perf")]);
    expect(row.source).toEqual({ kind: "file", taskspaceId: "t1", path: "a.md", line: 9 });
  });

  it("gives each line of a file its own row, since each is somewhere to go", () => {
    expect(groupHitRows([fileHit("a.md", 1, "perf"), fileHit("a.md", 9, "perf")])).toHaveLength(2);
  });

  it("keeps two tags on one line in one row", () => {
    expect(groupHitRows([fileHit("a.md", 1, "perf"), fileHit("a.md", 1, "docs")])).toHaveLength(1);
  });

  it("keeps first-seen order, which is the order the read produced", () => {
    const rows = groupHitRows([cardHit("c2", "a"), cardHit("c1", "b"), cardHit("c2", "c")]);
    expect(rows.map(({ key }) => key)).toEqual(["card:c2", "card:c1"]);
  });

  it("narrows a filtered list to the source its rows are", () => {
    const hits = [cardHit("c1", "perf"), fileHit("a.md", 1, "perf")];
    expect(groupHitRows(hits.filter(isCardHit)).map(({ source }) => source.cardId)).toEqual(["c1"]);
    expect(groupHitRows(hits.filter(isFileHit)).map(({ source }) => source.path)).toEqual(["a.md"]);
  });

  it("names each distinct tag once, sigil and all, in one order", () => {
    expect(taggedWith([cardHit("c1", "perf:cache"), cardHit("c1", "perf")])).toEqual([
      "'perf",
      "'perf:cache",
    ]);
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

  it("folds the case of the query, which is the side that comes from outside", () => {
    expect(tagMatches("FOO", "foo:bar")).toBe(true);
  });

  /**
   * The other side is a precondition rather than a courtesy, and this says so out loud: a
   * tag reaches here having been through `normalizeTag` at the moment it was matched, which
   * is what lets the filter behind every gather skip folding and composing once per hit.
   */
  it("takes the tag as already normalized", () => {
    expect(tagMatches("foo", normalizeTag("Foo:bar"))).toBe(true);
    expect(tagMatches("foo", "Foo:bar")).toBe(false);
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

describe("capHitsByKind", () => {
  const cardHit = (cardId: string): TagHit => ({
    tag: "perf",
    source: { kind: "card", cardId },
    excerpt: "",
  });
  const fileHit = (line: number): TagHit => ({
    tag: "perf",
    source: { kind: "file", taskspaceId: "t1", path: "a.md", line },
    excerpt: "",
  });

  const cards = (n: number) => Array.from({ length: n }, (_, i) => cardHit(`c${i}`));
  const files = (n: number) => Array.from({ length: n }, (_, i) => fileHit(i + 1));

  it("splits the two kinds apart", () => {
    const capped = capHitsByKind([cardHit("c1"), fileHit(1)], 10);

    expect(capped.cards.map(({ source }) => source.cardId)).toEqual(["c1"]);
    expect(capped.files.map(({ source }) => source.line)).toEqual([1]);
  });

  /**
   * The bug this exists for. `loadTagIndex` returns every card hit before any file hit, so a
   * single ceiling laid across the list was spent on cards before the files were reached: a
   * tag on more cards than the ceiling listed no files at all, and the panel said only that
   * it was showing part of a list — which reads as "there are no files under this tag".
   */
  it("does not let one kind spend the other's ceiling", () => {
    const capped = capHitsByKind([...cards(5), ...files(3)], 4);

    expect(capped.cards).toHaveLength(4);
    expect(capped.files).toHaveLength(3);
  });

  it("counts what each side was cut down from", () => {
    const capped = capHitsByKind([...cards(5), ...files(9)], 4);

    expect(capped.cardTotal).toBe(5);
    expect(capped.fileTotal).toBe(9);
  });

  it("keeps the order the gather produced", () => {
    const capped = capHitsByKind([...cards(3)], 2);

    expect(capped.cards.map(({ source }) => source.cardId)).toEqual(["c0", "c1"]);
  });
});

describe("truncationReasons", () => {
  it("says what a reason means rather than naming the budget it was", () => {
    expect(truncationReasons(["budget"])).toMatch(/budget left for/);
    expect(truncationReasons(["budget"])).not.toBe("budget");
  });

  it("joins several", () => {
    expect(truncationReasons(["depth", "unreadable"]).split("; ")).toHaveLength(2);
  });

  /** These cross a serialization boundary — the loader's return becomes the page's data — so
   *  a reason the drawing end does not know must not become `undefined` in a sentence. */
  it("falls back to the reason itself for one it does not know", () => {
    expect(truncationReasons(["quota" as never])).toBe("quota");
  });
});
