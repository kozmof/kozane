import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import TagsPage from "./+page.svelte";
import { buildTagTree } from "$lib/tag";
import type { TagHit } from "$lib/types";

/** Verify result links use source identities rather than display-row keys. */

const cardHit = (cardId: string, tag: string, excerpt: string): TagHit => ({
  tag,
  source: { kind: "card", cardId },
  excerpt,
});

const fileHit = (taskspaceId: string, path: string, line: number, tag: string): TagHit => ({
  tag,
  source: { kind: "file", taskspaceId, path, line },
  excerpt: `a line with :${tag} in it`,
});

function pageData(hits: TagHit[], over: Record<string, unknown> = {}) {
  return {
    namespaceId: null,
    namespaces: [{ id: "p1", name: "Namespace One", isDefault: true }],
    tree: buildTagTree(hits),
    tag: "perf",
    hits,
    cardTotal: hits.filter(({ source }) => source.kind === "card").length,
    fileTotal: hits.filter(({ source }) => source.kind === "file").length,
    truncated: [],
    missing: [],
    cardsTruncated: false,
    cardNamespaces: { c1: "p1", c2: "p1" },
    taskspaces: {
      t1: { name: "Notes", namespaceId: "p1" },
      t2: { name: "Drafts", namespaceId: "p1" },
    },
    cardPartitionIds: { c1: "b1", c2: "b1" },
    partitions: { b1: { name: "General", dot: "#abc" } },
    ...over,
  };
}

/** Renders the page as the loader would hand it over. `params` and `form` are the other
 *  halves of a page's props and are nothing to this one. */
const draw = (hits: TagHit[], over: Record<string, unknown> = {}) =>
  render(TagsPage, { props: { data: pageData(hits, over) as never, params: {}, form: null } });

const hrefOf = (text: string) => screen.getByText(text).closest("a")?.getAttribute("href") ?? null;

describe("tag index page", () => {
  /** Show the namespace name when the back link leads to its board. */
  describe("the way out", () => {
    const backLink = (container: HTMLElement, href: string) =>
      [...container.querySelectorAll("header a")].find((a) => a.getAttribute("href") === href);

    it("shows the namespace it goes back to when the index is narrowed to one", () => {
      const { container } = draw([cardHit("c1", "perf", "caching work")], { namespaceId: "p1" });
      const back = backLink(container, "/p1")!;
      expect(back.textContent?.trim()).toBe("Namespace One");
      expect(back.getAttribute("aria-label")).toBe("Back to Namespace One");
      expect(back.querySelector("svg")).not.toBeNull();
    });

    it("shows the icon alone when it leads to the whole list", () => {
      const { container } = draw([cardHit("c1", "perf", "caching work")]);
      const back = backLink(container, "/")!;
      expect(back.textContent?.trim()).toBe("");
      expect(back.getAttribute("aria-label")).toBe("All namespaces");
      expect(back.querySelector("svg")).not.toBeNull();
    });
  });

  it("links a card row to its own board, centred on the card", () => {
    draw([cardHit("c1", "perf", "caching work")]);

    expect(hrefOf("caching work")).toBe("/p1?card=c1");
  });

  it("names the partition a card is in", () => {
    draw([cardHit("c1", "perf", "caching work")]);

    expect(screen.getByText("General")).toBeTruthy();
  });

  // One row per card, whichever of its tags matched, and the row still links to that card.
  it("draws a card matched by two tags once", () => {
    const hits = [
      cardHit("c1", "perf", "caching work"),
      cardHit("c1", "perf:cache", "caching work"),
    ];

    draw(hits);

    expect(screen.getAllByText("caching work")).toHaveLength(1);
    expect(hrefOf("caching work")).toBe("/p1?card=c1");
    expect(screen.getByText(":perf :perf:cache")).toBeTruthy();
  });

  it("links a file row to the board that draws its taskspace, on that file", () => {
    draw([fileHit("t1", "notes/todo.md", 3, "perf")]);

    expect(hrefOf("notes/todo.md:3")).toBe("/p1?taskspace=t1&path=notes%2Ftodo.md");
  });

  /** Distinguish identical relative paths through their taskspace headings. */
  it("names the taskspace a group of file rows was found in", () => {
    const hits = [
      fileHit("t1", "notes/todo.md", 3, "perf"),
      fileHit("t2", "notes/todo.md", 3, "perf"),
    ];

    draw(hits);

    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByText("Drafts")).toBeTruthy();
    expect(screen.getAllByText("notes/todo.md:3")).toHaveLength(2);
  });

  it("says which part of a capped list is being shown", () => {
    const hits = [cardHit("c1", "perf", "one"), cardHit("c2", "perf", "two")];

    draw(hits, { cardTotal: 240 });

    expect(screen.getByText(/Showing the first 2 of 240 card hits/)).toBeTruthy();
  });

  /**
   * The two ceilings are separate, so the notice has to be too. One number over a list
   * holding both kinds cannot say which of them was cut, and the reader is looking for one
   * of them in particular.
   */
  it("says what was cut from each kind, not one number over both", () => {
    const hits = [cardHit("c1", "perf", "one"), fileHit("t1", "notes/todo.md", 3, "perf")];

    draw(hits, { cardTotal: 240, fileTotal: 900 });

    expect(
      screen.getByText(/first 1 of 240 card hits, and the first 1 of 900 file hits/),
    ).toBeTruthy();
  });

  it("says nothing about a cap when nothing was cut", () => {
    draw([cardHit("c1", "perf", "one")]);

    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  /**
   * Label capped totals as hits because several matching tags can produce one card row and
   * one distinct tree count.
   */
  it("counts the notice in hits, which is what was capped, and names them as hits", () => {
    const hits = [
      cardHit("c1", "perf", "caching work"),
      cardHit("c1", "perf:cache", "caching work"),
    ];

    draw(hits, { cardTotal: 240 });

    // Two hits, one row.
    expect(screen.getAllByText("caching work")).toHaveLength(1);
    expect(screen.getByText(/Showing the first 2 of 240 card hits/)).toBeTruthy();
  });

  /**
   * Report taskspace names with readable truncation reasons rather than internal scan-limit
   * names.
   */
  it("says a taskspace it could not read in full, by name and in words", () => {
    draw([cardHit("c1", "perf", "one")], {
      truncated: [{ taskspaceId: "t1", reasons: ["budget"] }],
    });

    expect(screen.getByText(/Notes was not read in full/)).toBeTruthy();
    expect(screen.getByText(/larger than the scan had budget left for/)).toBeTruthy();
  });

  /**
   * A reason on its own says something is wrong and not where, which is the half a reader can
   * act on. A directory carries its trailing slash through, so "the taskspace itself" does not
   * read as a file called `.`.
   */
  it("names a few of the files behind a truncation", () => {
    draw([cardHit("c1", "perf", "one")], {
      truncated: [
        { taskspaceId: "t1", reasons: ["too-large"], paths: ["media/talk.mp4", "logs/"] },
      ],
    });

    expect(screen.getByText(/for example media\/talk\.mp4, logs\//)).toBeTruthy();
  });

  /** Render truncation notices without path samples when older exports omit the field. */
  it("draws a truncation from an older export, which carries no paths", () => {
    draw([cardHit("c1", "perf", "one")], {
      truncated: [{ taskspaceId: "t1", reasons: ["budget"] }],
    });

    expect(screen.getByText(/Notes was not read in full/)).toBeTruthy();
    expect(screen.queryByText(/for example/)).toBeNull();
  });

  /** Describe an unavailable taskspace separately from a partially scanned one. */
  it("names a taskspace whose directory is gone, apart from the truncations", () => {
    draw([cardHit("c1", "perf", "one")], { missing: ["t1"] });

    expect(screen.getByText(/^Notes could not be read/)).toBeTruthy();
    expect(screen.queryByText(/was not read in full/)).toBeNull();
  });

  /** The half a reader can act on. One command settles every such record, so it is printed
   *  once however many of them there are. */
  it("gives the command that drops such records, once for all of them", () => {
    draw([cardHit("c1", "perf", "one")], { missing: ["t1", "t2"] });

    expect(screen.getByText(/^Notes could not be read/)).toBeTruthy();
    expect(screen.getByText(/^Drafts could not be read/)).toBeTruthy();
    expect(screen.getAllByText("kozane taskspace scan --apply --cleanup")).toHaveLength(1);
    expect(screen.getByText(/to drop the records.$/)).toBeTruthy();
  });

  /** Treat a missing `missing` field in older export data as an empty list. */
  it("draws a page from an older export, which carries no missing taskspaces", () => {
    draw([cardHit("c1", "perf", "one")], { missing: undefined });

    expect(screen.queryByText(/could not be read/)).toBeNull();
    // The hits it does carry are still drawn, which is the half that would have been lost.
    expect(screen.getByText("one")).toBeTruthy();
  });

  /**
   * Display the card limit alongside taskspace notices so users can see all sources of
   * incomplete results.
   */
  it("says when the cards themselves were not read in full", () => {
    draw([cardHit("c1", "perf", "one")], { cardsTruncated: true });

    expect(screen.getByText(/The cards were not read in full/)).toBeTruthy();
    expect(screen.getByText(/counts above are a floor/)).toBeTruthy();
  });

  /** Handle absent namespace lookups without building an undefined card URL. */
  /** Expose tag selection accessibly as well as through visual styling. */
  it("marks the selected tag in the tree as the current one", () => {
    draw([cardHit("c1", "perf", "one"), cardHit("c2", "docs", "two")], { tag: "perf" });

    const rows = screen.getAllByRole("link").filter((el) => el.textContent?.includes("perf"));
    const current = rows.filter((el) => el.getAttribute("aria-current") === "page");

    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("href")).toBe("/tags?tag=perf");
  });

  /** The count is drawn as a bare number in a column, which reads as "perf 3" alone. */
  it("says what a tag's count counts, for a reader who cannot see the column", () => {
    draw([cardHit("c1", "perf", "one"), fileHit("t1", "notes/todo.md", 3, "perf")]);

    expect(screen.getByText("1 card, 1 file")).toBeTruthy();
  });

  it("draws no link for a card whose namespace it was not told", () => {
    draw([cardHit("c9", "perf", "orphaned")], { cardNamespaces: {} });

    expect(hrefOf("orphaned")).toBeNull();
  });
});
