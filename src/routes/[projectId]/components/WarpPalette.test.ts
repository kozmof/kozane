import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import WarpPalette from "./WarpPalette.svelte";
import type { WarpListEntry } from "$lib/warp-list";

function entry(overrides: Partial<WarpListEntry> & { id: string }): WarpListEntry {
  return {
    projectId: "p1",
    projectName: "Kozane",
    label: 1,
    posX: 100,
    posY: 200,
    hint: null,
    isCurrent: true,
    ...overrides,
  };
}

const entries = [
  entry({ id: "w1", label: 1, hint: "schema migration" }),
  entry({ id: "w2", label: 2, posX: 900, posY: 200 }),
  entry({
    id: "w3",
    projectId: "p2",
    projectName: "Research",
    label: 1,
    isCurrent: false,
    hint: "Umesao 1969",
  }),
];

function makeProps(overrides: Record<string, unknown> = {}) {
  return { entries, onJump: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(), ...overrides };
}

const dialog = () => screen.getByRole("dialog", { name: "Warps" });
const highlighted = () =>
  screen.getAllByRole("option").find((el) => el.getAttribute("aria-selected") === "true");

describe("WarpPalette", () => {
  it("groups the rows by project and marks the current one", () => {
    render(WarpPalette, { props: makeProps() });

    expect(screen.getByText("Kozane (this project)")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("shows each warp's number and hint, and not its coordinates", () => {
    render(WarpPalette, { props: makeProps() });

    const row = screen.getAllByRole("option")[0];
    expect(row).toHaveTextContent("Warp 1");
    expect(row).toHaveTextContent("schema migration");
    // A warp is recognised by what is near it, not by where the board puts it.
    expect(row).not.toHaveTextContent("100, 200");
  });

  it("highlights the first row when no warp is focused", () => {
    render(WarpPalette, { props: makeProps() });

    expect(highlighted()).toHaveTextContent("Warp 1");
  });

  it("starts on the warp the board is already sitting on", () => {
    render(WarpPalette, { props: makeProps({ focusedWarpId: "w2" }) });

    expect(highlighted()).toHaveTextContent("Warp 2");
  });

  it("moves the highlight with the arrow keys, wrapping round", async () => {
    render(WarpPalette, { props: makeProps() });

    await fireEvent.keyDown(dialog(), { key: "ArrowDown" });
    expect(highlighted()).toHaveTextContent("Warp 2");

    await fireEvent.keyDown(dialog(), { key: "ArrowUp" });
    await fireEvent.keyDown(dialog(), { key: "ArrowUp" });
    expect(highlighted()).toHaveTextContent("Umesao 1969");
  });

  it("jumps to the highlighted warp on Enter", async () => {
    const onJump = vi.fn();
    render(WarpPalette, { props: makeProps({ onJump }) });

    await fireEvent.keyDown(dialog(), { key: "ArrowDown" });
    await fireEvent.keyDown(dialog(), { key: "Enter" });

    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ id: "w2" }));
  });

  it("jumps to a row that is clicked", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(WarpPalette, { props: makeProps({ onJump }) });

    await user.click(screen.getByRole("option", { name: /Umesao 1969/ }));

    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ id: "w3", projectId: "p2" }));
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(WarpPalette, { props: makeProps({ onClose }) });

    await fireEvent.keyDown(dialog(), { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("closes on the shift+arrow that opened it", async () => {
    const onClose = vi.fn();
    render(WarpPalette, { props: makeProps({ onClose }) });

    await fireEvent.keyDown(dialog(), { key: "ArrowRight", shiftKey: true });

    expect(onClose).toHaveBeenCalled();
  });

  it("closes on a click outside the panel", async () => {
    const onClose = vi.fn();
    const { container } = render(WarpPalette, { props: makeProps({ onClose }) });

    await fireEvent.mouseDown(container.querySelector('[role="presentation"]')!);

    expect(onClose).toHaveBeenCalled();
  });

  it("removes the warp a remove button is clicked on", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onJump = vi.fn();
    render(WarpPalette, { props: makeProps({ onDelete, onJump }) });

    await user.click(screen.getByRole("button", { name: "Remove warp 1 in Research" }));

    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "w3" }));
    // Removing is not warping: the view stays where it is.
    expect(onJump).not.toHaveBeenCalled();
  });

  it("has no remove buttons in a read-only export", () => {
    render(WarpPalette, { props: makeProps({ readonly: true }) });

    expect(screen.queryByRole("button", { name: /^Remove warp/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("says so when the workspace has no warps", () => {
    render(WarpPalette, { props: makeProps({ entries: [] }) });

    expect(screen.getByText(/No warps yet/)).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});
