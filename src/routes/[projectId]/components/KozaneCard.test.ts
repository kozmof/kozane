import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import KozaneCard from "./KozaneCard.svelte";

const color = { id: "bundle-1", bg: "#fff7ed", dot: "#f59e0b", name: "General", isDefault: false };

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    card: {
      id: "card-1",
      bundleId: "bundle-1",
      layerId: "layer-1",
      content: "Hello world",
      posX: 100,
      posY: 200,
      zIndex: 0,
      glueId: null,
      taskspaceId: null,
      width: null,
    },
    color,
    isSelected: false,
    isPrimaryUnglue: false,
    isComposing: false,
    dimmed: false,
    isDragging: false,
    cardWidth: 240,
    fontSize: 11.5,
    fontFamily: "sans-serif",
    showFooters: true,
    onCardMouseDown: vi.fn(),
    onCardClick: vi.fn(),
    onCardDblClick: vi.fn(),
    ...overrides,
  };
}

describe("KozaneCard", () => {
  it("renders card content", () => {
    render(KozaneCard, { props: makeProps() });
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("shows placeholder for empty content", () => {
    render(KozaneCard, {
      props: makeProps({ card: { ...makeProps().card, content: "" } }),
    });
    expect(screen.getByText("Empty card…")).toBeInTheDocument();
  });

  it("shows glue icon when glueId is set", () => {
    const { container } = render(KozaneCard, {
      props: makeProps({ card: { ...makeProps().card, glueId: "glue-1" } }),
    });
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("does not show glue icon when glueId is null", () => {
    const { container } = render(KozaneCard, { props: makeProps() });
    // Only the bundle dot SVG should not appear in footer area — glue svg is absent
    const footerSvgs = container.querySelectorAll("svg");
    expect(footerSvgs.length).toBe(0);
  });

  it("shows taskspace badge when taskspaceId is set", () => {
    render(KozaneCard, {
      props: makeProps({ card: { ...makeProps().card, taskspaceId: "taskspace-123" } }),
    });
    expect(screen.getByText("taskspace")).toBeInTheDocument();
  });

  it("does not show taskspace badge when taskspaceId is null", () => {
    render(KozaneCard, { props: makeProps() });
    expect(screen.queryByText("taskspace")).not.toBeInTheDocument();
  });

  it("renders bundle name", () => {
    render(KozaneCard, { props: makeProps() });
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("applies dimmed opacity when dimmed=true", () => {
    const { container } = render(KozaneCard, {
      props: makeProps({ dimmed: true }),
    });
    const card = container.querySelector("[role=button]") as HTMLElement;
    expect(card.style.opacity).toBe("0.3");
  });

  it("applies full opacity when dimmed=false", () => {
    const { container } = render(KozaneCard, { props: makeProps() });
    const card = container.querySelector("[role=button]") as HTMLElement;
    expect(card.style.opacity).toBe("1");
  });

  it("positions the card via inline style", () => {
    const { container } = render(KozaneCard, { props: makeProps() });
    const card = container.querySelector("[role=button]") as HTMLElement;
    expect(card.style.left).toBe("100px");
    expect(card.style.top).toBe("200px");
  });

  it("uses grabbing cursor while dragging", () => {
    const { container } = render(KozaneCard, {
      props: makeProps({ isDragging: true }),
    });
    const card = container.querySelector("[role=button]") as HTMLElement;
    expect(card.style.cursor).toBe("grabbing");
  });

  it("uses grab cursor when not dragging", () => {
    const { container } = render(KozaneCard, { props: makeProps() });
    const card = container.querySelector("[role=button]") as HTMLElement;
    expect(card.style.cursor).toBe("grab");
  });

  it("Enter key on card triggers onCardDblClick", async () => {
    const user = userEvent.setup();
    const onCardDblClick = vi.fn();
    render(KozaneCard, { props: makeProps({ onCardDblClick }) });
    const card = screen.getByRole("button");
    card.focus();
    await user.keyboard("{Enter}");
    expect(onCardDblClick).toHaveBeenCalledOnce();
  });

  it("Space key on card triggers onCardDblClick", async () => {
    const user = userEvent.setup();
    const onCardDblClick = vi.fn();
    render(KozaneCard, { props: makeProps({ onCardDblClick }) });
    const card = screen.getByRole("button");
    card.focus();
    await user.keyboard(" ");
    expect(onCardDblClick).toHaveBeenCalledOnce();
  });

  it("calls mouse handlers", async () => {
    const user = userEvent.setup();
    const onCardMouseDown = vi.fn();
    const onCardClick = vi.fn();
    render(KozaneCard, {
      props: makeProps({ onCardMouseDown, onCardClick }),
    });

    await user.click(screen.getByRole("button"));

    expect(onCardMouseDown).toHaveBeenCalledOnce();
    expect(onCardClick).toHaveBeenCalledOnce();
  });

  it("calls double-click handler", async () => {
    const user = userEvent.setup();
    const onCardDblClick = vi.fn();
    render(KozaneCard, { props: makeProps({ onCardDblClick }) });

    await user.dblClick(screen.getByRole("button"));

    expect(onCardDblClick).toHaveBeenCalledOnce();
  });

  it("exposes selected state with aria-pressed", () => {
    render(KozaneCard, { props: makeProps({ isSelected: true }) });
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("draws the card at the width it is given", () => {
    const { container } = render(KozaneCard, { props: makeProps({ cardWidth: 360 }) });
    const card = container.querySelector("[role=button]") as HTMLElement;
    expect(card.style.width).toBe("360px");
  });

  it("hides the resize handle until the card is armed", () => {
    render(KozaneCard, { props: makeProps() });
    // Absent rather than merely invisible: an unarmed board must carry no grab targets
    // along its card edges for a drag or a rectangle selection to catch on.
    expect(screen.queryByLabelText("Drag to resize card width")).not.toBeInTheDocument();
  });

  it("shows the resize handle once the card is armed", () => {
    render(KozaneCard, { props: makeProps({ isResizing: true }) });
    expect(screen.getByLabelText("Drag to resize card width")).toBeInTheDocument();
  });

  it("starts a resize from the handle without starting a card drag", async () => {
    const user = userEvent.setup();
    const onResizeMouseDown = vi.fn();
    const onCardMouseDown = vi.fn();
    render(KozaneCard, {
      props: makeProps({ isResizing: true, onResizeMouseDown, onCardMouseDown }),
    });

    await user.click(screen.getByLabelText("Drag to resize card width"));

    expect(onResizeMouseDown).toHaveBeenCalledOnce();
    // The handle sits on top of the card: without the stopPropagation it carries, this
    // press would move the card instead of widening it.
    expect(onCardMouseDown).not.toHaveBeenCalled();
  });

  /**
   * What a card does with the text it is given, beyond drawing it: a URL becomes an anchor
   * and a tag becomes a link to the index. Both are `segmentText`'s reading of the content,
   * which the tag index gathers by too — so these are also where a card is checked to draw
   * exactly what the index would find in it.
   */
  describe("text segments", () => {
    const withContent = (content: string, overrides: Record<string, unknown> = {}) =>
      makeProps({ card: { ...makeProps().card, content }, ...overrides });

    it("draws a tag as a link to where the caller sends it", () => {
      render(KozaneCard, {
        props: withContent("caching work 'perf:cache", {
          tagHref: (tag: string) => `/tags?tag=${tag}`,
        }),
      });

      const link = screen.getByRole("link", { name: "'perf:cache" });
      expect(link).toHaveAttribute("href", "/tags?tag=perf:cache");
    });

    /**
     * The card knows a tag when it sees one but not which project's index to send it to, so
     * a caller with no router — a component test, a static context — still gets the tag
     * marked rather than a link to nowhere.
     */
    it("marks a tag without linking it when there is nowhere to link to", () => {
      render(KozaneCard, { props: withContent("caching work 'perf") });

      expect(screen.getByText("'perf")).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("draws the tag as it was typed and links it as it is indexed", () => {
      render(KozaneCard, {
        props: withContent("about 'Perf", { tagHref: (tag: string) => `/tags?tag=${tag}` }),
      });

      // The text is what the writer typed; the link is the normalized tag, which is the one
      // the index is keyed by. A card that drew `'perf` would be rewriting the card.
      expect(screen.getByRole("link", { name: "'Perf" })).toHaveAttribute("href", "/tags?tag=perf");
    });

    it("leaves prose apostrophes as prose", () => {
      render(KozaneCard, {
        props: withContent("don't tag this, and 'quoted' stays text", {
          tagHref: (tag: string) => `/tags?tag=${tag}`,
        }),
      });

      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("draws a url with an apostrophe in it as one link and no tag", () => {
      render(KozaneCard, {
        props: withContent("see http://example.com/('foo) after", {
          tagHref: (tag: string) => `/tags?tag=${tag}`,
        }),
      });

      // The grammar cuts a URL out before looking for tags, so the address is a link and
      // nothing inside it is one. This is the case where the card and the index disagreed.
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(1);
      // The closing paren is sentence punctuation rather than part of the address, so the
      // span stops before it — and the apostrophe inside the span still opens nothing.
      expect(links[0]).toHaveAttribute("href", "http://example.com/('foo");
    });

    it("does not start a card drag when a tag is followed", async () => {
      const user = userEvent.setup();
      const onCardMouseDown = vi.fn();
      const onCardClick = vi.fn();
      render(KozaneCard, {
        props: withContent("about 'perf", {
          tagHref: (tag: string) => `/tags?tag=${tag}`,
          onCardMouseDown,
          onCardClick,
        }),
      });

      await user.click(screen.getByRole("link", { name: "'perf" }));

      // Same propagation stop a URL carries: following the link must not move the card or
      // change what is selected on the board being left behind.
      expect(onCardMouseDown).not.toHaveBeenCalled();
      expect(onCardClick).not.toHaveBeenCalled();
    });
  });
});
