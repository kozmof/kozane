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
    missing: [],
    cardsTruncated: false,
    cardProjects: { c1: "p1", c2: "p1" },
    taskspaces: {
      t1: { name: "Notes", projectId: "p1" },
      t2: { name: "Drafts", projectId: "p1" },
    },
    cardBundleIds: { c1: "b1", c2: "b1" },
    bundles: { b1: { name: "General", dot: "#abc" } },
    ...over,
  };
}

/** Renders the page as the loader would hand it over. `params` and `form` are the other
 *  halves of a page's props and are nothing to this one. */
const draw = (hits: TagHit[], over: Record<string, unknown> = {}) =>
  render(TagsPage, { props: { data: pageData(hits, over) as never, params: {}, form: null } });

const hrefOf = (text: string) => screen.getByText(text).closest("a")?.getAttribute("href") ?? null;

describe("tag index page", () => {
  /**
   * The way out is an icon, and the icon is the same drawing whether it leads to the whole
   * project list or to one project's board. Narrowed to a project it leads to that board, so
   * the name is shown beside the picture — nothing in the drawing could say which of the two
   * you are about to get.
   */
  describe("the way out", () => {
    const backLink = (container: HTMLElement, href: string) =>
      [...container.querySelectorAll("header a")].find((a) => a.getAttribute("href") === href);

    it("shows the project it goes back to when the index is narrowed to one", () => {
      const { container } = draw([cardHit("c1", "perf", "caching work")], { projectId: "p1" });
      const back = backLink(container, "/p1")!;
      expect(back.textContent?.trim()).toBe("Project One");
      expect(back.getAttribute("aria-label")).toBe("Back to Project One");
      expect(back.querySelector("svg")).not.toBeNull();
    });

    it("shows the icon alone when it leads to the whole list", () => {
      const { container } = draw([cardHit("c1", "perf", "caching work")]);
      const back = backLink(container, "/")!;
      expect(back.textContent?.trim()).toBe("");
      expect(back.getAttribute("aria-label")).toBe("All projects");
      expect(back.querySelector("svg")).not.toBeNull();
    });
  });

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
   * The notice counts hits, and has to say so. The cap is applied before the rows are
   * grouped, so a card carrying two matching tags is two of what the notice counts, one row
   * on the page, and one card in the tree beside it — three numbers that only agree once the
   * notice names its unit. Calling them "cards" made it contradict the two things drawn
   * either side of it. `kozane tag show` prints "card hits" for the same reason.
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
   * The name is joined from the taskspaces the gather walked, which is where a truncated one
   * always is — and the reasons are put into words rather than printed as the scanner's own
   * vocabulary.
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

  /**
   * The case above without the field, which is what a static export built before it existed
   * carries. The notice loses its paths and keeps everything else — it must not take the page
   * down, which is what reading `.length` off an absent array did. See `truncationPaths`.
   */
  it("draws a truncation from an older export, which carries no paths", () => {
    draw([cardHit("c1", "perf", "one")], {
      truncated: [{ taskspaceId: "t1", reasons: ["budget"] }],
    });

    expect(screen.getByText(/Notes was not read in full/)).toBeTruthy();
    expect(screen.queryByText(/for example/)).toBeNull();
  });

  /**
   * A record whose directory is gone, which is a different thing to have to say: the words a
   * truncation is drawn with — "was not read in full", a reason about files — describe a
   * taskspace that was read and not finished, and this one could not be opened. It was drawn
   * as one, and told a reader that "some files could not be read (for example ./)".
   */
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

  /**
   * The case above from an export built before the page said anything about such a taskspace,
   * which carries no `missing` at all. Nothing is drawn and the page still renders — reading
   * `.length` off an absent array is what would take it down. See `truncationPaths` for the
   * same rule about the same boundary.
   */
  it("draws a page from an older export, which carries no missing taskspaces", () => {
    draw([cardHit("c1", "perf", "one")], { missing: undefined });

    expect(screen.queryByText(/could not be read/)).toBeNull();
    // The hits it does carry are still drawn, which is the half that would have been lost.
    expect(screen.getByText("one")).toBeTruthy();
  });

  /**
   * The card side has a ceiling of its own, and it is drawn beside the taskspace notices
   * rather than instead of them: to a reader whose tag is missing, "not every card was read"
   * and "not every file was read" are the same fact about the same gather.
   */
  it("says when the cards themselves were not read in full", () => {
    draw([cardHit("c1", "perf", "one")], { cardsTruncated: true });

    expect(screen.getByText(/The cards were not read in full/)).toBeTruthy();
    expect(screen.getByText(/counts above are a floor/)).toBeTruthy();
  });

  /**
   * `Record<string, string>` says the lookup cannot miss when it can — a tag page left open
   * while the card moved, or a narrowed record that did not name it. A row that draws
   * `/undefined?card=…` looks right and goes nowhere.
   */
  /**
   * The tree marks its selection with a background and a weight, which is nothing to a
   * reader who cannot see it — and the project nav in the same header already says
   * `aria-current`, so the page was answering the same question two ways.
   */
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

  it("draws no link for a card whose project it was not told", () => {
    draw([cardHit("c9", "perf", "orphaned")], { cardProjects: {} });

    expect(hrefOf("orphaned")).toBeNull();
  });
});
