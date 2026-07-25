import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import CardComposer from "./CardComposer.svelte";
import { DEFAULT_UI_CONFIG } from "$lib/ui-config";

const bundles = [
  { id: "b1", name: "General", bg: "#fff7ed", dot: "#f59e0b", isDefault: true },
  { id: "b2", name: "Research", bg: "#f0fdf4", dot: "#22c55e", isDefault: false },
];

const otherProjects = [
  { id: "p2", name: "Project Beta" },
  { id: "p3", name: "Project Gamma" },
];

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    editingCard: null,
    selectedCards: [],
    selectionGlueRels: [],
    primaryCard: null,
    bundles,
    defaultBundleId: "b1",
    otherProjects: [],
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

  it("preserves a draft when background refresh replaces its props", async () => {
    const user = userEvent.setup();
    const { rerender } = render(CardComposer, { props: makeProps() });
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "aa");

    await rerender(makeProps({ bundles: bundles.map((bundle) => ({ ...bundle })) }));

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
  it("runs customized single-card shortcuts", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const onCancel = vi.fn();
    const onLayerChange = vi.fn();
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
        onLayerChange,
        onDeleteSelected,
        shortcuts,
      }),
    });

    expect(screen.getByRole("button", { name: "Copy card ID (v)" })).toBeInTheDocument();
    await user.keyboard("v{Home}{End}{Backspace}q");

    expect(writeText).toHaveBeenCalledWith("card-1");
    expect(onLayerChange).toHaveBeenNthCalledWith(1, "card-1", "front");
    expect(onLayerChange).toHaveBeenNthCalledWith(2, "card-1", "back");
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
        otherProjects,
        onGlueSelected,
        onUnglueOne,
        shortcuts,
      }),
    });

    await user.keyboard("jnp");

    expect(onGlueSelected).toHaveBeenCalledWith(["card-1", "card-2"]);
    expect(onUnglueOne).toHaveBeenCalledWith("card-1");
    expect(screen.getByRole("button", { name: "Project Beta" })).toBeInTheDocument();
  });
});

describe("CardComposer — Move to project", () => {
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

  it("does not show the Move to project button when otherProjects is empty", () => {
    render(CardComposer, { props: makeProps({ selectedCards, otherProjects: [] }) });
    expect(screen.queryByRole("button", { name: /Move to project/ })).not.toBeInTheDocument();
  });

  it("shows the Move to project button in selection mode when other projects exist", () => {
    render(CardComposer, { props: makeProps({ selectedCards, otherProjects }) });
    expect(screen.getByRole("button", { name: /Move to project/ })).toBeInTheDocument();
  });

  it("does not show the Move to project button in create mode even with other projects", () => {
    render(CardComposer, { props: makeProps({ otherProjects }) });
    expect(screen.queryByRole("button", { name: /Move to project/ })).not.toBeInTheDocument();
  });

  it("opens a dropdown listing other projects on click", async () => {
    const user = userEvent.setup();
    render(CardComposer, { props: makeProps({ selectedCards, otherProjects }) });

    await user.click(screen.getByRole("button", { name: /Move to project/ }));

    expect(screen.getByRole("button", { name: "Project Beta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project Gamma" })).toBeInTheDocument();
  });

  it("calls onMoveToProject with selected card ids and target project id", async () => {
    const user = userEvent.setup();
    const onMoveToProject = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards, otherProjects, onMoveToProject }) });

    await user.click(screen.getByRole("button", { name: /Move to project/ }));
    await user.click(screen.getByRole("button", { name: "Project Beta" }));

    expect(onMoveToProject).toHaveBeenCalledOnce();
    expect(onMoveToProject).toHaveBeenCalledWith(["card-1", "card-2"], "p2");
  });

  it("closes the dropdown after selecting a project", async () => {
    const user = userEvent.setup();
    render(CardComposer, {
      props: makeProps({ selectedCards, otherProjects, onMoveToProject: vi.fn() }),
    });

    await user.click(screen.getByRole("button", { name: /Move to project/ }));
    await user.click(screen.getByRole("button", { name: "Project Beta" }));

    expect(screen.queryByRole("button", { name: "Project Beta" })).not.toBeInTheDocument();
  });
});

describe("CardComposer — copy card ID", () => {
  const selectedCard = {
    id: "019f71f2-a749-7539-9342-17b86d2a0000",
    content: "Selected card",
    bundleId: "b1",
    posX: 0,
    posY: 0,
    glueId: null,
    workingCopyId: null,
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

describe("CardComposer — card layers", () => {
  const selectedCard = {
    id: "card-layer",
    content: "Layered card",
    bundleId: "b1",
    posX: 0,
    posY: 0,
    glueId: null,
    workingCopyId: null,
  };

  it("moves a single selected card to the front or back", async () => {
    const user = userEvent.setup();
    const onLayerChange = vi.fn();
    render(CardComposer, { props: makeProps({ selectedCards: [selectedCard], onLayerChange }) });
    await user.click(screen.getByRole("button", { name: "Bring to front (])" }));
    await user.click(screen.getByRole("button", { name: "Send to back ([)" }));
    expect(onLayerChange).toHaveBeenNthCalledWith(1, "card-layer", "front");
    expect(onLayerChange).toHaveBeenNthCalledWith(2, "card-layer", "back");
  });

  it("hides layer actions for multiple selected cards", () => {
    render(CardComposer, {
      props: makeProps({ selectedCards: [selectedCard, { ...selectedCard, id: "other" }] }),
    });
    expect(screen.queryByRole("button", { name: "Bring to front (])" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to back ([)" })).not.toBeInTheDocument();
  });
});
