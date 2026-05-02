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
});
