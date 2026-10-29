import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "../../../lib/constants.js";
import {
  DEFAULT_UI_CONFIG,
  NEW_CARD_PLACEMENTS,
  UI_BOOL_FIELDS,
  UI_NUM_RANGES,
  UI_SHORTCUT_FIELDS,
  type UiConfig,
} from "../../../lib/ui-config.js";

export type FieldKind = "string" | "number" | "boolean" | "choice" | "list" | "shortcut";

export type FieldGroup =
  | "General"
  | "Server"
  | "Taskspace"
  | "Cards and canvas"
  | "View"
  | "File editor"
  | "Shortcuts";

/** Groups in the order the page shows them. */
export const FIELD_GROUPS: readonly FieldGroup[] = [
  "General",
  "Server",
  "Taskspace",
  "Cards and canvas",
  "View",
  "File editor",
  "Shortcuts",
];

/** One setting the config page can edit. */
export type FieldSpec = {
  /** Dotted path in `config.json`, e.g. `ui.defaultZoom`. */
  path: string;
  group: FieldGroup;
  label: string;
  help: string;
  kind: FieldKind;
  /** Value used when the key is absent. `undefined` for required fields, which have none. */
  defaultValue?: unknown;
  /** Required fields can be changed but not removed. */
  required: boolean;
  min?: number;
  max?: number;
  /** Integer-only numbers, such as ports. */
  integer?: boolean;
  choices?: readonly string[];
};

/**
 * Group and description for each `ui` setting. Typed against {@link UiConfig}, so a new
 * setting does not compile until it has an entry here and shows on the page.
 */
const UI_FIELD_INFO: Record<keyof UiConfig, { group: FieldGroup; help: string }> = {
  defaultFontSize: { group: "Cards and canvas", help: "Card text size in pixels." },
  defaultFontFamily: { group: "Cards and canvas", help: "CSS font family for card text." },
  defaultCardWidth: { group: "Cards and canvas", help: "Width of cards that were never resized." },
  newCardPlacement: {
    group: "Cards and canvas",
    help: "Where new cards go: one vertical list, or a four-column grid.",
  },
  canvasWidth: { group: "Cards and canvas", help: "Board width in pixels." },
  canvasHeight: { group: "Cards and canvas", help: "Board height in pixels." },
  contentMax: {
    group: "Cards and canvas",
    help: "Longest card text allowed, in UTF-16 code units.",
  },
  warpMarkerSize: { group: "Cards and canvas", help: "Diameter of a warp marker in pixels." },
  defaultZoom: { group: "View", help: "Zoom level when a board opens." },
  zoomStep: { group: "View", help: "How much one zoom button press or scroll step changes zoom." },
  leftPanelWidth: { group: "View", help: "Width of the partition panel in pixels." },
  rightPanelWidth: { group: "View", help: "Width of the scope panel in pixels." },
  defaultShowFooter: { group: "View", help: "Show card footers when a board opens." },
  defaultShowSidePanel: { group: "View", help: "Show the side panels when a board opens." },
  defaultShowWarps: { group: "View", help: "Show warp markers when a board opens." },
  showZoomControl: { group: "View", help: "Show the zoom buttons and zoom level." },
  showLayerControl: { group: "View", help: "Show the layer icon." },
  showSidePanelToggle: {
    group: "View",
    help: "Show the side panel toggle icon. The panel shortcut works either way.",
  },
  editorVimMode: { group: "File editor", help: "Use Vim key bindings in the file editor." },
  editorAutoSave: {
    group: "File editor",
    help: "Save shortly after typing stops. Turn off to save only by hand.",
  },
  toggleFootersShortcut: { group: "Shortcuts", help: "Show or hide card footers." },
  togglePanelsShortcut: { group: "Shortcuts", help: "Show or hide the side panels." },
  focusCardInputShortcut: { group: "Shortcuts", help: "Move focus to the card input." },
  clearSelectionShortcut: { group: "Shortcuts", help: "Clear the selection." },
  copyCardIdShortcut: { group: "Shortcuts", help: "Copy the selected card's ID." },
  bringCardToFrontShortcut: { group: "Shortcuts", help: "Bring the selected card to the front." },
  sendCardToBackShortcut: { group: "Shortcuts", help: "Send the selected card to the back." },
  glueCardsShortcut: { group: "Shortcuts", help: "Glue the selected cards." },
  unglueCardShortcut: { group: "Shortcuts", help: "Unglue the selected card." },
  moveCardsShortcut: { group: "Shortcuts", help: "Move the selected cards." },
  resizeCardShortcut: { group: "Shortcuts", help: "Resize the selected card." },
  squashCardShortcut: { group: "Shortcuts", help: "Squash the selected card." },
  deleteCardsShortcut: { group: "Shortcuts", help: "Delete the selected cards." },
  openFilePaletteShortcut: { group: "Shortcuts", help: "Open the file palette." },
  setWarpShortcut: { group: "Shortcuts", help: "Set a warp." },
  toggleWarpsShortcut: { group: "Shortcuts", help: "Show or hide warps." },
  removeWarpShortcut: { group: "Shortcuts", help: "Remove the focused warp." },
  addInventoryShortcut: { group: "Shortcuts", help: "Add an inventory." },
};

/** `showZoomControl` → `Show zoom control`. */
export function labelFor(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function uiKind(key: keyof UiConfig): FieldKind {
  if (key === "newCardPlacement") return "choice";
  if ((UI_SHORTCUT_FIELDS as readonly string[]).includes(key)) return "shortcut";
  if ((UI_BOOL_FIELDS as readonly string[]).includes(key)) return "boolean";
  if (key in UI_NUM_RANGES) return "number";
  return "string";
}

function uiFields(): FieldSpec[] {
  return (Object.keys(UI_FIELD_INFO) as (keyof UiConfig)[]).map((key) => {
    const kind = uiKind(key);
    const range = UI_NUM_RANGES[key];
    return {
      path: `ui.${key}`,
      group: UI_FIELD_INFO[key].group,
      label: labelFor(key),
      help: UI_FIELD_INFO[key].help,
      kind,
      defaultValue: DEFAULT_UI_CONFIG[key],
      required: false,
      ...(range && { min: range[0], max: range[1] }),
      ...(kind === "choice" && { choices: NEW_CARD_PLACEMENTS }),
    };
  });
}

/** Every setting the config page shows, in display order within each group. */
export function configFields(): FieldSpec[] {
  const fields: FieldSpec[] = [
    {
      path: "name",
      group: "General",
      label: "Workspace name",
      help: "Shown in the namespace list. Blank uses the folder name.",
      kind: "string",
      required: true,
    },
    {
      path: "server.host",
      group: "Server",
      label: "Host",
      help: "Address `kozane open` binds to. Takes effect on the next start.",
      kind: "string",
      defaultValue: DEFAULT_SERVER_HOST,
      required: false,
    },
    {
      path: "server.port",
      group: "Server",
      label: "Port",
      help: "Port `kozane open` listens on. 0 picks a free port. Takes effect on the next start.",
      kind: "number",
      defaultValue: DEFAULT_SERVER_PORT,
      required: false,
      min: 0,
      max: 65535,
      integer: true,
    },
    {
      path: "taskspace.defaultDir",
      group: "Taskspace",
      label: "Default directory",
      help: "Where new taskspaces are created, relative to the workspace.",
      kind: "string",
      required: true,
    },
    {
      path: "taskspace.searchRoots",
      group: "Taskspace",
      label: "Search roots",
      help: "Directories `kozane taskspace scan` searches, one per line.",
      kind: "list",
      required: true,
    },
    ...uiFields(),
  ];
  const order = new Map(FIELD_GROUPS.map((group, index) => [group, index]));
  // A stable sort keeps declaration order inside each group.
  return fields.sort((a, b) => order.get(a.group)! - order.get(b.group)!);
}
