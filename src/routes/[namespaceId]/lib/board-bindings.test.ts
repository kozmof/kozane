import { describe, expect, it, vi } from "vitest";
import { boardKeyBindings, type BoardCommands, type BoardShortcuts } from "./board-bindings.js";
import { runKeyBindings } from "./board-keymap.js";

const shortcuts: BoardShortcuts = {
  focusCardInputShortcut: "n",
  toggleFootersShortcut: "f",
  togglePanelsShortcut: "p",
  toggleWarpsShortcut: "w",
  setWarpShortcut: "s",
  removeWarpShortcut: "x",
};

function commands(overrides: Partial<BoardCommands> = {}): BoardCommands {
  return {
    readonly: false,
    hasPendingFrame: () => false,
    noSelection: () => true,
    hasFocusedWarp: () => true,
    dismissPendingFrame: vi.fn(),
    focusComposer: vi.fn(),
    toggleFooters: vi.fn(),
    togglePanels: vi.fn(),
    toggleWarps: vi.fn(),
    openWarpPalette: vi.fn(),
    warpToward: vi.fn(() => true),
    setWarpHere: vi.fn(),
    removeFocusedWarp: vi.fn(),
    ...overrides,
  };
}

function press(c: BoardCommands, key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key, cancelable: true, ...init });
  runKeyBindings(e, boardKeyBindings(shortcuts, c));
  return e;
}

describe("boardKeyBindings", () => {
  it("lets Escape dismiss a pending frame before anything else", () => {
    const c = commands({ hasPendingFrame: () => true });
    expect(press(c, "Escape").defaultPrevented).toBe(true);
    expect(c.dismissPendingFrame).toHaveBeenCalled();
  });

  it("leaves the board shortcuts to the composer while cards are selected", () => {
    const c = commands({ noSelection: () => false });
    press(c, "f");
    press(c, "ArrowUp");
    press(c, "s");
    expect(c.toggleFooters).not.toHaveBeenCalled();
    expect(c.warpToward).not.toHaveBeenCalled();
    expect(c.setWarpHere).not.toHaveBeenCalled();
  });

  it("tells Shift+arrow, which opens the palette, from a plain arrow, which warps", () => {
    const c = commands();
    press(c, "ArrowLeft", { shiftKey: true });
    expect(c.openWarpPalette).toHaveBeenCalled();
    expect(c.warpToward).not.toHaveBeenCalled();
    press(c, "ArrowLeft");
    expect(c.warpToward).toHaveBeenCalledWith("ArrowLeft");
  });

  it("leaves an arrow to the browser when there is no warp that way", () => {
    expect(press(commands({ warpToward: () => false }), "ArrowDown").defaultPrevented).toBe(false);
    expect(press(commands(), "ArrowDown").defaultPrevented).toBe(true);
  });

  it("does not set or remove warps, or focus the composer, on a read-only board", () => {
    const c = commands({ readonly: true });
    press(c, "n");
    press(c, "s");
    press(c, "x");
    expect(c.focusComposer).not.toHaveBeenCalled();
    expect(c.setWarpHere).not.toHaveBeenCalled();
    expect(c.removeFocusedWarp).not.toHaveBeenCalled();
  });

  it("removes a warp only when one is focused", () => {
    const c = commands({ hasFocusedWarp: () => false });
    press(c, "x");
    expect(c.removeFocusedWarp).not.toHaveBeenCalled();
  });
});
