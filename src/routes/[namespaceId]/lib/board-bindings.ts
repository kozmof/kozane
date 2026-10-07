import { ARROW_KEYS } from "$lib/constants";
import type { UiConfig } from "$lib/ui-config";
import type { KeyBinding } from "./board-keymap.js";

/** The configurable shortcuts the board's table reads. */
export type BoardShortcuts = Pick<
  UiConfig,
  | "focusCardInputShortcut"
  | "toggleFootersShortcut"
  | "togglePanelsShortcut"
  | "toggleWarpsShortcut"
  | "setWarpShortcut"
  | "removeWarpShortcut"
>;

/** Page-owned actions and state used by the keyboard binding table. */
export type BoardCommands = {
  readonly: boolean;
  /** Whether a scope frame drawn with Alt is waiting for a scope. */
  hasPendingFrame: () => boolean;
  /**
   * Whether no card is selected. While cards are selected the composer's action bar has the
   * keyboard, so every board shortcut below the composer's own asks this.
   */
  noSelection: () => boolean;
  hasFocusedWarp: () => boolean;
  dismissPendingFrame: () => void;
  focusComposer: () => void;
  toggleFooters: () => void;
  togglePanels: () => void;
  toggleWarps: () => void;
  openWarpPalette: () => void;
  /** Warps toward an arrow key's direction, answering whether there was a warp to go to. */
  warpToward: (key: string) => boolean;
  setWarpHere: () => void;
  removeFocusedWarp: () => void;
};

/**
 * Board bindings and their conditions. See `board-keymap.ts` for dispatch rules.
 *
 * Put pending-frame Escape first so it cancels the rectangle before other actions. Use
 * `noSelection` on warp bindings so the composer owns those keys while cards are selected.
 */
export function boardKeyBindings(shortcuts: BoardShortcuts, c: BoardCommands): KeyBinding[] {
  return [
    {
      // Handle Escape when focus is outside the prompt. The prompt handles it itself while
      // its input is focused.
      name: "dismiss pending scope frame",
      keys: ["Escape"],
      when: c.hasPendingFrame,
      preventDefault: true,
      run: c.dismissPendingFrame,
    },
    {
      name: "focus the card composer",
      keys: [shortcuts.focusCardInputShortcut],
      when: () => !c.readonly,
      preventDefault: true,
      run: c.focusComposer,
    },
    {
      name: "toggle card footers",
      keys: [shortcuts.toggleFootersShortcut],
      when: c.noSelection,
      run: c.toggleFooters,
    },
    {
      name: "toggle side panels",
      keys: [shortcuts.togglePanelsShortcut],
      when: c.noSelection,
      run: c.togglePanels,
    },
    {
      name: "toggle warp markers",
      keys: [shortcuts.toggleWarpsShortcut],
      when: c.noSelection,
      run: c.toggleWarps,
    },
    {
      // Any arrow opens the same palette.
      name: "open the warp palette",
      keys: ARROW_KEYS,
      shift: true,
      when: c.noSelection,
      preventDefault: true,
      run: c.openWarpPalette,
    },
    {
      name: "warp in a direction",
      keys: ARROW_KEYS,
      shift: false,
      when: c.noSelection,
      // Prevent the default action only when a warp is found in the requested direction.
      // Otherwise leave the arrow key to the browser.
      run: (e) => {
        if (c.warpToward(e.key)) e.preventDefault();
      },
    },
    {
      name: "set a warp here",
      keys: [shortcuts.setWarpShortcut],
      when: () => c.noSelection() && !c.readonly,
      run: c.setWarpHere,
    },
    {
      name: "remove the focused warp",
      keys: [shortcuts.removeWarpShortcut],
      when: () => c.noSelection() && !c.readonly && c.hasFocusedWarp(),
      run: c.removeFocusedWarp,
    },
  ];
}
