import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import CardComposer from "./CardComposer.svelte";

const bundles = [
  { id: "b1", name: "General", bg: "#fff7ed", dot: "#f59e0b" },
  { id: "b2", name: "Research", bg: "#f0fdf4", dot: "#22c55e" },
];

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    editingCard: null,
    selectedCards: [],
    selectionGlueRels: [],
    primaryCard: null,
    bundles,
    defaultBundleId: "b1",
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

describe("CardComposer — create mode", () => {
  it("shows create-mode placeholder", () => {
    render(CardComposer, { props: makeProps() });
    expect(screen.getByPlaceholderText(/Write a card/)).toBeInTheDocument();
  });

  it("does not show 'Esc to cancel' hint in create mode", () => {
    render(CardComposer, { props: makeProps() });
    expect(screen.queryByText(/Esc to cancel/)).not.toBeInTheDocument();
  });

  it("submit button is disabled when textarea is empty", () => {
    render(CardComposer, { props: makeProps() });
    expect(screen.getByRole("button", { name: /Create card/ })).toBeDisabled();
  });

  it("submits on Enter with content", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(CardComposer, { props: makeProps({ onSubmit }) });
    await user.type(screen.getByRole("textbox"), "Hello world");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(null, "Hello world", "b1");
  });

  it("does not submit on Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(CardComposer, { props: makeProps({ onSubmit }) });
    await user.type(screen.getByRole("textbox"), "Hello");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit when content is only whitespace", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(CardComposer, { props: makeProps({ onSubmit }) });
    await user.type(screen.getByRole("textbox"), "   ");
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("trims whitespace from submitted content", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(CardComposer, { props: makeProps({ onSubmit }) });
    await user.type(screen.getByRole("textbox"), "  trimmed  ");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith(null, "trimmed", "b1");
  });

  it("calls onCancel on Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(CardComposer, { props: makeProps({ onCancel }) });
    await user.type(screen.getByRole("textbox"), "Hi");
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("submits new cards with the selected bundle", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(CardComposer, { props: makeProps({ onSubmit }) });

    await user.click(screen.getByRole("button", { name: "Select bundle" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));
    await user.type(screen.getByRole("textbox"), "Bundled");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledWith(null, "Bundled", "b2");
  });
});

describe("CardComposer — edit mode", () => {
  const editingCard = { id: "card-1", content: "Existing content", bundleId: "b1" };

  it("shows edit-mode placeholder", () => {
    render(CardComposer, { props: makeProps({ editingCard }) });
    expect(screen.getByPlaceholderText(/Edit card/)).toBeInTheDocument();
  });

  it("shows 'Esc to cancel' button in edit mode", () => {
    render(CardComposer, { props: makeProps({ editingCard }) });
    expect(screen.getByText(/Esc to cancel/)).toBeInTheDocument();
  });

  it("pre-fills textarea with existing content", () => {
    render(CardComposer, { props: makeProps({ editingCard }) });
    expect(screen.getByRole("textbox")).toHaveValue("Existing content");
  });

  it("submits with card id in edit mode", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(CardComposer, { props: makeProps({ editingCard, onSubmit }) });
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "Updated");
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("card-1", "Updated", "b1");
  });

  it("calls onBundleChange when the bundle changes in edit mode", async () => {
    const user = userEvent.setup();
    const onBundleChange = vi.fn();
    render(CardComposer, { props: makeProps({ editingCard, onBundleChange }) });

    await user.click(screen.getByRole("button", { name: "Select bundle" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));

    expect(onBundleChange).toHaveBeenCalledWith("b2");
  });
});

describe("CardComposer — selection mode", () => {
  const selectedCards = [
    {
      id: "card-1",
      content: "One",
      bundleId: "b1",
      posX: 0,
      posY: 0,
      glueId: null,
      workingCopyId: null,
    },
    {
      id: "card-2",
      content: "Two",
      bundleId: "b1",
      posX: 0,
      posY: 0,
      glueId: null,
      workingCopyId: null,
    },
  ];

  it("shows selected count and clear selection action", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards, onCancel }) });

    expect(screen.getByText("2 cards")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "×" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onGlueSelected for unglued multi-selection", async () => {
    const user = userEvent.setup();
    const onGlueSelected = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards, onGlueSelected }) });

    await user.click(screen.getByRole("button", { name: /Glue/ }));

    expect(onGlueSelected).toHaveBeenCalledWith(["card-1", "card-2"]);
  });

  it("calls onUnglueSelected when every selected card shares a glue group", async () => {
    const user = userEvent.setup();
    const gluedCards = selectedCards.map((card) => ({ ...card, glueId: "glue-1" }));
    const onUnglueSelected = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards: gluedCards, onUnglueSelected }) });

    await user.click(screen.getByRole("button", { name: /Unglue all/ }));

    expect(onUnglueSelected).toHaveBeenCalledWith(["card-1", "card-2"]);
  });

  it("calls onUnglueOne for the primary glued card", async () => {
    const user = userEvent.setup();
    const primaryCard = { ...selectedCards[0], glueId: "glue-1" };
    const onUnglueOne = vi.fn();
    render(CardComposer, {
      props: makeProps({
        selectedCards: [primaryCard, selectedCards[1]],
        primaryCard,
        onUnglueOne,
      }),
    });

    await user.click(screen.getByRole("button", { name: /Unglue this/ }));

    expect(onUnglueOne).toHaveBeenCalledWith("card-1");
  });

  it("calls onDeleteSelected with selected card ids", async () => {
    const user = userEvent.setup();
    const onDeleteSelected = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards, onDeleteSelected }) });

    await user.click(screen.getByRole("button", { name: /Delete 2 cards/ }));

    expect(onDeleteSelected).toHaveBeenCalledWith(["card-1", "card-2"]);
  });

  it("shows the selected card bundle instead of the default bundle", () => {
    const researchCards = selectedCards.map((card) => ({ ...card, bundleId: "b2" }));
    render(CardComposer, { props: makeProps({ selectedCards: researchCards }) });

    expect(screen.getByText("Research")).toBeInTheDocument();
  });

  it("calls onSelectionBundleChange when the bundle changes", async () => {
    const user = userEvent.setup();
    const onSelectionBundleChange = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards, onSelectionBundleChange }) });

    await user.click(screen.getByRole("button", { name: "Select bundle" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));

    expect(onSelectionBundleChange).toHaveBeenCalledWith(["card-1", "card-2"], "b2");
  });
});
