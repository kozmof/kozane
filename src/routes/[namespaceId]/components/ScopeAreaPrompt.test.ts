import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import ScopeAreaPrompt from "./ScopeAreaPrompt.svelte";

afterEach(cleanup);

const SCOPES = [
  { id: "s1", name: "Now" },
  { id: "s2", name: "Later" },
];

function mount(overrides: Record<string, unknown> = {}) {
  const onChoose = vi.fn();
  const onCreate = vi.fn();
  const onCancel = vi.fn();
  const rendered = render(ScopeAreaPrompt, {
    props: {
      scopes: SCOPES,
      cardCount: 3,
      onChoose,
      onCreate,
      onCancel,
      ...overrides,
    },
  });
  return { ...rendered, onChoose, onCreate, onCancel };
}

describe("ScopeAreaPrompt", () => {
  it("offers every scope on the board, framed or not", () => {
    mount();

    // A scope may be framed in several places at once, so one that already has a frame here
    // is still on offer: framing it again is how you say it is organised in two places.
    expect(screen.getByRole("button", { name: "Now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Later" })).toBeTruthy();
  });

  it("reports which scope was picked", async () => {
    const { onChoose } = mount();

    await userEvent.click(screen.getByRole("button", { name: "Later" }));

    expect(onChoose).toHaveBeenCalledWith("s2");
  });

  it("says how many cards the rectangle covers", () => {
    mount({ cardCount: 3 });
    expect(screen.getByText(/Frame 3 cards as/)).toBeTruthy();
  });

  it("counts one card in the singular", () => {
    mount({ cardCount: 1 });
    expect(screen.getByText(/Frame 1 card as/)).toBeTruthy();
  });

  it("creates a scope from the name typed into it", async () => {
    const { onCreate } = mount();

    await userEvent.type(screen.getByLabelText("New scope name"), "Sprint 1{Enter}");

    expect(onCreate).toHaveBeenCalledWith("Sprint 1");
  });

  it("does not create a scope from an empty or blank name", async () => {
    const { onCreate } = mount();

    await userEvent.type(screen.getByLabelText("New scope name"), "   {Enter}");

    expect(onCreate).not.toHaveBeenCalled();
  });

  // The board has no scopes yet, which is where this feature most wants to work: drawing a
  // rectangle and naming it is how the first scope gets made.
  it("still offers to name one when there are no scopes at all", () => {
    mount({ scopes: [] });
    expect(screen.getByLabelText("New scope name")).toBeTruthy();
  });

  it("cancels on the close button", async () => {
    const { onCancel } = mount();

    await userEvent.click(screen.getByRole("button", { name: "Cancel frame" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels on Escape", async () => {
    const { onCancel } = mount();

    await fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
