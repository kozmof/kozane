import { ARROW_KEYS } from "../../constants/index.js";
import type { UiConfig } from "../../ui-config.js";
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
  | "addInventoryShortcut"
  | "openFileBrowserShortcut"
>;

/** Page-owned actions and state used by the keyboard binding table. */
export type BoardCommands = {
  readonly: boolean;
  /** Whether a scope frame drawn with Alt is waiting for a scope. */
  hasPendingFrame: () => boolean;
  /**
   * Whether no card is selected. Require this for board shortcuts whose keys belong to the
   * composer's action bar during selection.
   */
  noSelection: () => boolean;
  hasFocusedWarp: () => boolean;
  dismissPendingFrame: () => void;
  focusComposer: () => void;
  toggleFooters: () => void;
  togglePanels: () => void;
  toggleWarps: () => void;
  openWarpPalette: () => void;
  moveCurrentLayer: (direction: number) => void;
  /** Navigate in the arrow key's direction and return whether a warp was found. */
  warpToward: (key: string) => boolean;
  setWarpHere: () => void;
  removeFocusedWarp: () => void;
  /** Drops a new inventory icon where a warp would be set. */
  addInventoryHere: () => void;
  /** Opens the three-column browser of scopes, taskspaces, and files. */
  openFileBrowser: () => void;
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
      name: "toggle the side panel",
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
      name: "move the current layer",
      keys: ["ArrowUp", "ArrowDown"],
      shift: true,
      preventDefault: true,
      run: (e) => c.moveCurrentLayer(e.key === "ArrowUp" ? 1 : -1),
    },
    {
      name: "open the warp palette",
      keys: ["ArrowLeft", "ArrowRight"],
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
    {
      name: "add an inventory here",
      keys: [shortcuts.addInventoryShortcut],
      when: () => c.noSelection() && !c.readonly,
      run: c.addInventoryHere,
    },
    {
      // Read-only exports can still browse embedded files, so this stays available there.
      name: "open the file browser",
      keys: [shortcuts.openFileBrowserShortcut],
      when: c.noSelection,
      preventDefault: true,
      run: c.openFileBrowser,
    },
  ];
}
