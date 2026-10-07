import { ARROW_KEYS, CANVAS_W, CANVAS_H, CONTENT_MAX } from "./constants.js";

export type NewCardPlacement = "grid" | "vertical-list";

export type UiConfig = {
  defaultFontSize: number;
  defaultFontFamily: string;
  defaultCardWidth: number;
  newCardPlacement: NewCardPlacement;
  defaultZoom: number;
  zoomStep: number;
  leftPanelWidth: number;
  rightPanelWidth: number;
  defaultShowFooter: boolean;
  defaultShowSidePanel: boolean;
  defaultShowWarps: boolean;
  /**
   * Whether the file editor starts in Vim normal mode with Vim bindings. Disabled by default
   * so typing inserts text immediately.
   */
  editorVimMode: boolean;
  /** Diameter of a warp marker, in canvas pixels. */
  warpMarkerSize: number;
  toggleFootersShortcut: string;
  togglePanelsShortcut: string;
  focusCardInputShortcut: string;
  clearSelectionShortcut: string;
  copyCardIdShortcut: string;
  bringCardToFrontShortcut: string;
  sendCardToBackShortcut: string;
  glueCardsShortcut: string;
  unglueCardShortcut: string;
  moveCardsShortcut: string;
  resizeCardShortcut: string;
  squashCardShortcut: string;
  deleteCardsShortcut: string;
  openFilePaletteShortcut: string;
  setWarpShortcut: string;
  toggleWarpsShortcut: string;
  removeWarpShortcut: string;
  canvasWidth: number;
  canvasHeight: number;
  /** Workspace card text limit in UTF-16 code units, enforced by HTTP and CLI writers. */
  contentMax: number;
};

export const DEFAULT_UI_CONFIG: UiConfig = {
  defaultFontSize: 11.5,
  defaultFontFamily: "monospace",
  defaultCardWidth: 210,
  newCardPlacement: "vertical-list",
  defaultZoom: 1,
  zoomStep: 0.05,
  leftPanelWidth: 216,
  rightPanelWidth: 232,
  defaultShowFooter: false,
  defaultShowSidePanel: false,
  defaultShowWarps: true,
  editorVimMode: false,
  warpMarkerSize: 20,
  toggleFootersShortcut: "f",
  togglePanelsShortcut: "b",
  focusCardInputShortcut: "i",
  clearSelectionShortcut: "Escape",
  copyCardIdShortcut: "c",
  bringCardToFrontShortcut: "]",
  sendCardToBackShortcut: "[",
  glueCardsShortcut: "g",
  unglueCardShortcut: "u",
  moveCardsShortcut: "m",
  resizeCardShortcut: "r",
  squashCardShortcut: "s",
  deleteCardsShortcut: "Delete",
  openFilePaletteShortcut: "e",
  setWarpShortcut: "a",
  // Shift+A. Shortcuts are compared against `event.key`, which already carries the shift.
  toggleWarpsShortcut: "A",
  removeWarpShortcut: "x",
  canvasWidth: CANVAS_W,
  canvasHeight: CANVAS_H,
  contentMax: CONTENT_MAX,
};

/**
 * The widths a card may be drawn at. Shared by `ui.defaultCardWidth` and by a card's own
 * `width` column, so resizing a card on the board cannot reach a size the setting behind
 * it would have been refused for.
 */
export const CARD_WIDTH_RANGE: [number, number] = [40, 1200];

export const UI_NUM_RANGES: Partial<Record<keyof UiConfig, [number, number]>> = {
  defaultFontSize: [4, 128],
  defaultCardWidth: CARD_WIDTH_RANGE,
  defaultZoom: [0.1, 10],
  zoomStep: [0.01, 1],
  leftPanelWidth: [80, 800],
  rightPanelWidth: [80, 800],
  warpMarkerSize: [8, 64],
  canvasWidth: [400, 20000],
  canvasHeight: [400, 20000],
  /**
   * Bounds for the configurable card text limit. Higher limits increase snapshot payloads
   * because polling includes complete card text.
   */
  contentMax: [100, 1_000_000],
};

export const UI_BOOL_FIELDS = [
  "defaultShowFooter",
  "defaultShowSidePanel",
  "defaultShowWarps",
  "editorVimMode",
] as const;

export const NEW_CARD_PLACEMENTS = ["grid", "vertical-list"] as const;

/**
 * Every field that binds a key. Checked for keys the UI reserves and for two fields
 * bound to the same key, neither of which a per-field type check can see.
 */
export const UI_SHORTCUT_FIELDS = [
  "toggleFootersShortcut",
  "togglePanelsShortcut",
  "focusCardInputShortcut",
  "clearSelectionShortcut",
  "copyCardIdShortcut",
  "bringCardToFrontShortcut",
  "sendCardToBackShortcut",
  "glueCardsShortcut",
  "unglueCardShortcut",
  "moveCardsShortcut",
  "resizeCardShortcut",
  "squashCardShortcut",
  "deleteCardsShortcut",
  "openFilePaletteShortcut",
  "setWarpShortcut",
  "toggleWarpsShortcut",
  "removeWarpShortcut",
] as const;

/** Built on {@link UI_SHORTCUT_FIELDS}, so a new shortcut is key-checked by adding it there. */
export const UI_STR_FIELDS = ["defaultFontFamily", ...UI_SHORTCUT_FIELDS] as const;

/** Every field name a `ui` block may carry. Anything else is an unknown key. */
export const UI_KNOWN_KEYS = Object.keys(DEFAULT_UI_CONFIG) as (keyof UiConfig)[];

export type ConfigIssue = {
  /** Dotted path of the offending field, e.g. `ui.defaultZoom`. */
  path: string;
  severity: "error" | "warning";
  /** Reason, without the `Invalid Kozane config:` prefix. */
  message: string;
  /** The rejected value, when there was one to show. */
  found?: unknown;
};

export type ValidationResult<T> = {
  value: T;
  issues: ConfigIssue[];
};

/**
 * Validate all UI settings and collect every issue. Keep valid fields and use defaults for
 * invalid ones. Parsing and diagnostics decide how to report the issues.
 */
export function validateUiOverrides(ui: unknown): ValidationResult<Partial<UiConfig>> {
  const issues: ConfigIssue[] = [];
  const reject = (path: string, message: string, found: unknown): void => {
    issues.push({ path, severity: "error", message, found });
  };

  if (ui === undefined) return { value: {}, issues };
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    reject("ui", "ui must be an object", ui);
    return { value: {}, issues };
  }

  const raw = ui as Record<string, unknown>;
  const value: Partial<UiConfig> = {};
  const accept = (field: keyof UiConfig, accepted: unknown): void => {
    (value as Record<string, unknown>)[field] = accepted;
  };

  for (const [field, [lo, hi]] of Object.entries(UI_NUM_RANGES)) {
    const candidate = raw[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      reject(`ui.${field}`, `ui.${field} must be a number`, candidate);
      continue;
    }
    if (candidate < lo || candidate > hi) {
      reject(`ui.${field}`, `ui.${field} must be between ${lo} and ${hi}`, candidate);
      continue;
    }
    accept(field as keyof UiConfig, candidate);
  }

  for (const field of UI_BOOL_FIELDS) {
    const candidate = raw[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== "boolean") {
      reject(`ui.${field}`, `ui.${field} must be a boolean`, candidate);
      continue;
    }
    accept(field, candidate);
  }

  for (const field of UI_STR_FIELDS) {
    const candidate = raw[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") {
      reject(`ui.${field}`, `ui.${field} must be a string`, candidate);
      continue;
    }
    accept(field, candidate);
  }

  checkShortcuts(raw, value, issues);

  const placement = raw.newCardPlacement;
  if (placement !== undefined) {
    if (NEW_CARD_PLACEMENTS.includes(placement as never)) {
      value.newCardPlacement = placement as NewCardPlacement;
    } else {
      reject(
        "ui.newCardPlacement",
        `ui.newCardPlacement must be "grid" or "vertical-list"`,
        placement,
      );
    }
  }

  return { value, issues };
}

/**
 * Check reserved shortcuts and collisions against effective settings, including defaults.
 * Drop invalid reserved-key overrides and warn when two actions share a key. Report only
 * explicitly configured fields.
 */
function checkShortcuts(
  raw: Record<string, unknown>,
  value: Partial<UiConfig>,
  issues: ConfigIssue[],
): void {
  const reserved: readonly string[] = ARROW_KEYS;
  for (const field of UI_SHORTCUT_FIELDS) {
    const candidate = value[field];
    if (candidate === undefined || !reserved.includes(candidate)) continue;
    issues.push({
      path: `ui.${field}`,
      severity: "error",
      message: `ui.${field} must not be "${candidate}", which moves between warps`,
      found: candidate,
    });
    delete value[field];
  }

  const effective = { ...DEFAULT_UI_CONFIG, ...value };
  const fieldsByKey = new Map<string, (keyof UiConfig)[]>();
  for (const field of UI_SHORTCUT_FIELDS) {
    const key = effective[field];
    // An empty binding matches no key at all, so any number of them collide with nothing.
    if (key === "") continue;
    fieldsByKey.set(key, [...(fieldsByKey.get(key) ?? []), field]);
  }

  for (const [key, fields] of fieldsByKey) {
    if (fields.length < 2) continue;
    const named = fields.map((field) => `ui.${field}`).join(", ");
    for (const field of fields) {
      if (raw[field] === undefined) continue;
      issues.push({
        path: `ui.${field}`,
        severity: "warning",
        message: `${named} are bound to the same key "${key}"`,
        found: key,
      });
    }
  }
}

export type ParseUiOptions = {
  /**
   * `true` (the CLI reading a config the user just edited): reject an invalid field
   * with an error naming it. `false` (the server loading a config at request time):
   * drop the field and fall back to its default, because a bad value in one setting
   * must not take the whole workspace down.
   */
  strict: boolean;
};

/**
 * Validates the `ui` block of a workspace config. Shared by the CLI and the server
 * so the two can never disagree about which values are acceptable.
 */
export function parseUiOverrides(ui: unknown, { strict }: ParseUiOptions): Partial<UiConfig> {
  const { value, issues } = validateUiOverrides(ui);
  // Reject errors only. Warnings describe usable configurations and must not block the CLI.
  const blocking = issues.find((issue) => issue.severity === "error");
  if (strict && blocking) throw new Error(`Invalid Kozane config: ${blocking.message}`);
  return value;
}
