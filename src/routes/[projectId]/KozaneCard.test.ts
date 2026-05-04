import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import KozaneCard from "./KozaneCard.svelte";

const color = { id: "bundle-1", bg: "#fff7ed", dot: "#f59e0b", name: "General" };

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    card: {
      id: "card-1",
      bundleId: "bundle-1",
      content: "Hello world",
      posX: 100,
      posY: 200,
      glueId: null,
      workingCopyId: null,
    },
    color,
    isSelected: false,
    isPrimaryUnglue: false,
    isComposing: false,
    dimmed: false,
    isDragging: false,
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

  it("shows wc badge when workingCopyId is set", () => {
    render(KozaneCard, {
      props: makeProps({ card: { ...makeProps().card, workingCopyId: "wc-123" } }),
    });
    expect(screen.getByText("wc")).toBeInTheDocument();
  });

  it("does not show wc badge when workingCopyId is null", () => {
    render(KozaneCard, { props: makeProps() });
    expect(screen.queryByText("wc")).not.toBeInTheDocument();
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
});
