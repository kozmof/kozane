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

/**
 * What the board's keys act on. The page owns every one of these — the state they read and
 * the components they reach — so the table below is only what key means what, and when.
 */
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
 * What each key does on the board, and under what conditions. See `board-keymap.ts` for why
 * this is a table and what the dispatcher guarantees about it.
 *
 * The order is load-bearing in two places:
 *
 * - The pending-frame Escape comes first, so a rectangle waiting for a scope is what
 *   Escape means while one is up, whatever else may be bound to it.
 * - The composer owns the keyboard while cards are selected, which is what keeps the
 *   warp keys from colliding with its action bar. Each of those bindings says so with
 *   `noSelection`, where the binding is rather than where a reader has to remember it.
 */
export function boardKeyBindings(shortcuts: BoardShortcuts, c: BoardCommands): KeyBinding[] {
  return [
    {
      // The prompt handles Escape itself while its input holds focus — the page's typing
      // guard stops anything typed there reaching the board — and this is the same key with
      // focus anywhere else.
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
      // Any of the four arrows opens the same list: the direction is how the hand already
      // reaches for warping, not a choice of which warps to show.
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
      // The one binding that cancels the key conditionally rather than declaring
      // `preventDefault`: arrowing past the last warp in a direction finds nothing, and the
      // key has to be left to the browser when it does.
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
