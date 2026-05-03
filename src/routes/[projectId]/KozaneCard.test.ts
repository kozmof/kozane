import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import KozaneCard from "./KozaneCard.svelte";

const color = { bg: "#fff7ed", dot: "#f59e0b", name: "General" };

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    card: {
      id: "card-1",
      bundleId: "bundle-1",
      content: "Hello world",
      posX: 100,
      posY: 200,
      tieCount: 0,
      workingCopyId: null,
    },
    color,
    isSelected: false,
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

  it("shows tie count when tieCount > 0", () => {
    render(KozaneCard, {
      props: makeProps({ card: { ...makeProps().card, tieCount: 3 } }),
    });
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("does not show tie count when tieCount is 0", () => {
    render(KozaneCard, { props: makeProps() });
    expect(screen.queryByText("0")).not.toBeInTheDocument();
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
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onCardDblClick = vi.fn();
    render(KozaneCard, { props: makeProps({ onCardDblClick }) });
    const card = screen.getByRole("button");
    card.focus();
    await user.keyboard("{Enter}");
    expect(onCardDblClick).toHaveBeenCalledOnce();
  });
});
