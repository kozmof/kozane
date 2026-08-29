import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import TagsPage from "./+page.svelte";
import { buildTagTree } from "$lib/tag";
import type { TagHit } from "$lib/types";

/**
 * The page draws rows it links away from, and every link is built from something a hit
 * carries. These assert the links, because a row that lists the right text under the wrong
 * href is a row that looks right and goes nowhere — which is exactly what happened when the
 * key a row was grouped under was mistaken for the card id it was built from.
 */

const cardHit = (cardId: string, tag: string, excerpt: string): TagHit => ({
  tag,
  source: { kind: "card", cardId },
  excerpt,
});

const fileHit = (taskspaceId: string, path: string, line: number, tag: string): TagHit => ({
  tag,
  source: { kind: "file", taskspaceId, path, line },
  excerpt: `a line with '${tag} in it`,
});

function pageData(hits: TagHit[], over: Record<string, unknown> = {}) {
  return {
    projectId: null,
    projects: [{ id: "p1", name: "Project One", isDefault: true }],
    tree: buildTagTree(hits),
    tag: "perf",
    hits,
    cardTotal: hits.filter(({ source }) => source.kind === "card").length,
    fileTotal: hits.filter(({ source }) => source.kind === "file").length,
    truncated: [],
    cardProjects: { c1: "p1", c2: "p1" },
    taskspaceProjects: { t1: "p1", t2: "p1" },
    cardBundleIds: { c1: "b1", c2: "b1" },
    bundles: { b1: { name: "General", dot: "#abc" } },
    taskspaces: [
      { id: "t1", name: "Notes", projectId: "p1" },
      { id: "t2", name: "Drafts", projectId: "p1" },
    ],
    ...over,
  };
}

/** Renders the page as the loader would hand it over. `params` and `form` are the other
 *  halves of a page's props and are nothing to this one. */
const draw = (hits: TagHit[], over: Record<string, unknown> = {}) =>
  render(TagsPage, { props: { data: pageData(hits, over) as never, params: {}, form: null } });

const hrefOf = (text: string) => screen.getByText(text).closest("a")?.getAttribute("href") ?? null;

describe("tag index page", () => {
  it("links a card row to its own board, centred on the card", () => {
    draw([cardHit("c1", "perf", "caching work")]);

    expect(hrefOf("caching work")).toBe("/p1?card=c1");
  });

  it("names the bundle a card is in", () => {
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
    expect(screen.getByText("'perf 'perf:cache")).toBeTruthy();
  });

  it("links a file row to the board that draws its taskspace, on that file", () => {
    draw([fileHit("t1", "notes/todo.md", 3, "perf")]);

    expect(hrefOf("notes/todo.md:3")).toBe("/p1?taskspace=t1&path=notes%2Ftodo.md");
  });

  /** The paths are relative to a taskspace and say nothing on their own — two taskspaces
   *  holding the same file draw two rows that read identically without this. */
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

    expect(screen.getByText(/Showing the first 2 of 240 cards/)).toBeTruthy();
  });

  /**
   * The two ceilings are separate, so the notice has to be too. One number over a list
   * holding both kinds cannot say which of them was cut, and the reader is looking for one
   * of them in particular.
   */
  it("says what was cut from each kind, not one number over both", () => {
    const hits = [cardHit("c1", "perf", "one"), fileHit("t1", "notes/todo.md", 3, "perf")];

    draw(hits, { cardTotal: 240, fileTotal: 900 });

    expect(screen.getByText(/first 1 of 240 cards, and the first 1 of 900 lines/)).toBeTruthy();
  });

  it("says nothing about a cap when nothing was cut", () => {
    draw([cardHit("c1", "perf", "one")]);

    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  /**
   * The name comes with the truncation rather than being joined from the taskspace list,
   * which a static export does not publish — and the reasons are put into words rather than
   * printed as the scanner's own vocabulary.
   */
  it("says a taskspace it could not read in full, by name and in words", () => {
    draw([cardHit("c1", "perf", "one")], {
      truncated: [{ taskspaceId: "t1", taskspaceName: "Notes", reasons: ["budget"] }],
      taskspaces: [],
    });

    expect(screen.getByText(/Notes was not read in full/)).toBeTruthy();
    expect(screen.getByText(/larger than the scan had budget left for/)).toBeTruthy();
  });
});
