import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import CardComposer from "./CardComposer.svelte";
import { DEFAULT_UI_CONFIG } from "$lib/ui-config";

const partitions = [
  { id: "b1", name: "General", bg: "#fff7ed", dot: "#f59e0b", isDefault: true },
  { id: "b2", name: "Research", bg: "#f0fdf4", dot: "#22c55e", isDefault: false },
];

const otherNamespaces = [
  { id: "p2", name: "Namespace Beta" },
  { id: "p3", name: "Namespace Gamma" },
];

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    editingCard: null,
    selectedCards: [],
    selectionGlueRels: [],
    primaryCard: null,
    partitions,
    defaultPartitionId: "b1",
    layers: [],
    otherNamespaces: [],
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

describe("CardComposer — create mode", () => {
  it("shows create-mode label", () => {
    render(CardComposer, { props: makeProps() });
    expect(screen.getByLabelText(/Write a card/)).toBeInTheDocument();
  });

  it("preserves a draft when background refresh replaces its props", async () => {
    const user = userEvent.setup();
    const { rerender } = render(CardComposer, { props: makeProps() });
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "aa");

    await rerender(makeProps({ partitions: partitions.map((partition) => ({ ...partition })) }));

    expect(textarea).toHaveValue("aa");
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
    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });

  it("submits new cards with the selected partition", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(CardComposer, { props: makeProps({ onSubmit }) });

    await user.click(screen.getByRole("button", { name: "Select partition" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));
    await user.type(screen.getByRole("textbox"), "Bundled");
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledWith(null, "Bundled", "b2");
  });

  it("restores the last create partition after selecting a card", async () => {
    const user = userEvent.setup();
    const selectedCard = {
      id: "card-1",
      content: "General card",
      partitionId: "b1",
      posX: 0,
      posY: 0,
      glueId: null,
      taskspaceId: null,
    };
    const { rerender } = render(CardComposer, { props: makeProps() });

    await user.click(screen.getByRole("button", { name: "Select partition" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));
    await rerender(makeProps({ selectedCards: [selectedCard], primaryCard: selectedCard }));
    expect(screen.getByText("General")).toBeInTheDocument();

    await rerender(makeProps());

    expect(screen.getByText("Research")).toBeInTheDocument();
  });
});

describe("CardComposer — edit mode", () => {
  const editingCard = { id: "card-1", content: "Existing content", partitionId: "b1" };

  it("shows edit-mode label", () => {
    render(CardComposer, { props: makeProps({ editingCard }) });
    expect(screen.getByLabelText(/Edit card/)).toBeInTheDocument();
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

  it("calls onPartitionChange when the partition changes in edit mode", async () => {
    const user = userEvent.setup();
    const onPartitionChange = vi.fn();
    render(CardComposer, { props: makeProps({ editingCard, onPartitionChange }) });

    await user.click(screen.getByRole("button", { name: "Select partition" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));

    expect(onPartitionChange).toHaveBeenCalledWith("b2");
  });
});

describe("CardComposer — selection mode", () => {
  const selectedCards = [
    {
      id: "card-1",
      content: "One",
      partitionId: "b1",
      posX: 0,
      posY: 0,
      glueId: null,
      taskspaceId: null,
    },
    {
      id: "card-2",
      content: "Two",
      partitionId: "b1",
      posX: 0,
      posY: 0,
      glueId: null,
      taskspaceId: null,
    },
  ];

  it("shows selected count and clear selection action", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards, onCancel }) });

    expect(screen.getByText("2 cards")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection (Escape)" }));

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

  it("shows the selected card partition instead of the default partition", () => {
    const researchCards = selectedCards.map((card) => ({ ...card, partitionId: "b2" }));
    render(CardComposer, { props: makeProps({ selectedCards: researchCards }) });

    expect(screen.getByText("Research")).toBeInTheDocument();
  });

  it("calls onSelectionPartitionChange when the partition changes", async () => {
    const user = userEvent.setup();
    const onSelectionPartitionChange = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards, onSelectionPartitionChange }) });

    await user.click(screen.getByRole("button", { name: "Select partition" }));
    await user.click(screen.getByRole("option", { name: /Research/ }));

    expect(onSelectionPartitionChange).toHaveBeenCalledWith(["card-1", "card-2"], "b2");
  });

  it("arms resizing from the button and from the shortcut", async () => {
    const user = userEvent.setup();
    const onResizeToggle = vi.fn();
    render(CardComposer, {
      props: makeProps({ selectedCards: [selectedCards[0]], onResizeToggle }),
    });

    await user.click(screen.getByRole("button", { name: "Resize (r)" }));
    await user.keyboard("r");

    expect(onResizeToggle).toHaveBeenNthCalledWith(1, "card-1");
    expect(onResizeToggle).toHaveBeenNthCalledWith(2, "card-1");
  });

  it("reads as armed once the card is the one being resized", () => {
    render(CardComposer, {
      props: makeProps({ selectedCards: [selectedCards[0]], resizingCardId: "card-1" }),
    });

    expect(screen.getByRole("button", { name: "Done resizing (r)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("does not offer resizing for a multi-card selection", async () => {
    const user = userEvent.setup();
    const onResizeToggle = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards, onResizeToggle }) });

    await user.keyboard("r");

    // One handle, one card: with several selected there is no saying which of them a drag
    // on a shared handle would be about to widen.
    expect(screen.queryByRole("button", { name: /Resize/ })).not.toBeInTheDocument();
    expect(onResizeToggle).not.toHaveBeenCalled();
  });

  it("runs customized single-card shortcuts", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const onCancel = vi.fn();
    const onStackOrderChange = vi.fn();
    const onDeleteSelected = vi.fn();
    const shortcuts = {
      ...DEFAULT_UI_CONFIG,
      clearSelectionShortcut: "q",
      copyCardIdShortcut: "v",
      bringCardToFrontShortcut: "Home",
      sendCardToBackShortcut: "End",
      deleteCardsShortcut: "Backspace",
    };
    render(CardComposer, {
      props: makeProps({
        selectedCards: [selectedCards[0]],
        onCancel,
        onStackOrderChange,
        onDeleteSelected,
        shortcuts,
      }),
    });

    expect(screen.getByRole("button", { name: "Copy card ID (v)" })).toBeInTheDocument();
    await user.keyboard("v{Home}{End}{Backspace}q");

    expect(writeText).toHaveBeenCalledWith("card-1");
    expect(onStackOrderChange).toHaveBeenNthCalledWith(1, ["card-1"], "front");
    expect(onStackOrderChange).toHaveBeenNthCalledWith(2, ["card-1"], "back");
    expect(onDeleteSelected).toHaveBeenCalledWith(["card-1"]);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("runs customized multi-card shortcuts", async () => {
    const user = userEvent.setup();
    const primaryCard = { ...selectedCards[0], glueId: "glue-1" };
    const onGlueSelected = vi.fn();
    const onUnglueOne = vi.fn();
    const shortcuts = {
      ...DEFAULT_UI_CONFIG,
      glueCardsShortcut: "j",
      unglueCardShortcut: "n",
      moveCardsShortcut: "p",
    };
    render(CardComposer, {
      props: makeProps({
        selectedCards: [primaryCard, selectedCards[1]],
        primaryCard,
        otherNamespaces,
        onGlueSelected,
        onUnglueOne,
        shortcuts,
      }),
    });

    await user.keyboard("jnp");

    expect(onGlueSelected).toHaveBeenCalledWith(["card-1", "card-2"]);
    expect(onUnglueOne).toHaveBeenCalledWith("card-1");
    expect(screen.getByRole("button", { name: "Namespace Beta" })).toBeInTheDocument();
  });
});

describe("CardComposer — Move to namespace", () => {
  const selectedCards = [
    {
      id: "card-1",
      content: "One",
      partitionId: "b1",
      posX: 0,
      posY: 0,
      glueId: null,
      taskspaceId: null,
    },
    {
      id: "card-2",
      content: "Two",
      partitionId: "b1",
      posX: 0,
      posY: 0,
      glueId: null,
      taskspaceId: null,
    },
  ];

  it("does not show the Move to namespace button when otherNamespaces is empty", () => {
    render(CardComposer, { props: makeProps({ selectedCards, otherNamespaces: [] }) });
    expect(screen.queryByRole("button", { name: /Move to namespace/ })).not.toBeInTheDocument();
  });

  it("shows the Move to namespace button in selection mode when other namespaces exist", () => {
    render(CardComposer, { props: makeProps({ selectedCards, otherNamespaces }) });
    expect(screen.getByRole("button", { name: /Move to namespace/ })).toBeInTheDocument();
  });

  it("does not show the Move to namespace button in create mode even with other namespaces", () => {
    render(CardComposer, { props: makeProps({ otherNamespaces }) });
    expect(screen.queryByRole("button", { name: /Move to namespace/ })).not.toBeInTheDocument();
  });

  it("opens a dropdown listing other namespaces on click", async () => {
    const user = userEvent.setup();
    render(CardComposer, { props: makeProps({ selectedCards, otherNamespaces }) });

    await user.click(screen.getByRole("button", { name: /Move to namespace/ }));

    expect(screen.getByRole("button", { name: "Namespace Beta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Namespace Gamma" })).toBeInTheDocument();
  });

  it("calls onMoveToNamespace with selected card ids and target namespace id", async () => {
    const user = userEvent.setup();
    const onMoveToNamespace = vi.fn();
    render(CardComposer, {
      props: makeProps({ selectedCards, otherNamespaces, onMoveToNamespace }),
    });

    await user.click(screen.getByRole("button", { name: /Move to namespace/ }));
    await user.click(screen.getByRole("button", { name: "Namespace Beta" }));

    expect(onMoveToNamespace).toHaveBeenCalledOnce();
    expect(onMoveToNamespace).toHaveBeenCalledWith(["card-1", "card-2"], "p2");
  });

  it("closes the dropdown after selecting a namespace", async () => {
    const user = userEvent.setup();
    render(CardComposer, {
      props: makeProps({ selectedCards, otherNamespaces, onMoveToNamespace: vi.fn() }),
    });

    await user.click(screen.getByRole("button", { name: /Move to namespace/ }));
    await user.click(screen.getByRole("button", { name: "Namespace Beta" }));

    expect(screen.queryByRole("button", { name: "Namespace Beta" })).not.toBeInTheDocument();
  });
});

describe("CardComposer — copy card ID", () => {
  const selectedCard = {
    id: "019f71f2-a749-7539-9342-17b86d2a0000",
    content: "Selected card",
    partitionId: "b1",
    posX: 0,
    posY: 0,
    glueId: null,
    taskspaceId: null,
  };

  it("shows the copy action for a single selected card", () => {
    render(CardComposer, { props: makeProps({ selectedCards: [selectedCard] }) });
    expect(screen.getByRole("button", { name: "Copy card ID (c)" })).toBeInTheDocument();
  });

  it("copies the full card ID and shows success feedback", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(CardComposer, { props: makeProps({ selectedCards: [selectedCard] }) });

    await user.click(screen.getByRole("button", { name: "Copy card ID (c)" }));

    expect(writeText).toHaveBeenCalledWith(selectedCard.id);
    expect(screen.getByText("Copied ID")).toBeInTheDocument();
  });

  it("hides the copy action when multiple cards are selected", () => {
    render(CardComposer, {
      props: makeProps({ selectedCards: [selectedCard, { ...selectedCard, id: "card-2" }] }),
    });
    expect(screen.queryByRole("button", { name: "Copy card ID (c)" })).not.toBeInTheDocument();
  });
});

describe("CardComposer — card stacking order", () => {
  const selectedCard = {
    id: "card-layer",
    content: "Layered card",
    partitionId: "b1",
    posX: 0,
    posY: 0,
    glueId: null,
    taskspaceId: null,
  };

  it("moves a single selected card to the front or back", async () => {
    const user = userEvent.setup();
    const onStackOrderChange = vi.fn();
    render(CardComposer, {
      props: makeProps({ selectedCards: [selectedCard], onStackOrderChange }),
    });
    await user.click(screen.getByRole("button", { name: "Bring to front (])" }));
    await user.click(screen.getByRole("button", { name: "Send to back ([)" }));
    expect(onStackOrderChange).toHaveBeenNthCalledWith(1, ["card-layer"], "front");
    expect(onStackOrderChange).toHaveBeenNthCalledWith(2, ["card-layer"], "back");
  });

  it("hides layer actions for an unglued multi-card selection", () => {
    render(CardComposer, {
      props: makeProps({ selectedCards: [selectedCard, { ...selectedCard, id: "other" }] }),
    });
    expect(screen.queryByRole("button", { name: "Bring to front (])" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to back ([)" })).not.toBeInTheDocument();
  });

  it("moves a whole glue group to the front or back together", async () => {
    const user = userEvent.setup();
    const onStackOrderChange = vi.fn();
    const glued = { ...selectedCard, glueId: "glue-1" };
    render(CardComposer, {
      props: makeProps({
        selectedCards: [glued, { ...glued, id: "other" }],
        onStackOrderChange,
      }),
    });
    await user.click(screen.getByRole("button", { name: "Bring to front (])" }));
    expect(onStackOrderChange).toHaveBeenCalledWith(["card-layer", "other"], "front");
  });
});
