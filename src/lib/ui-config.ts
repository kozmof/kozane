import { CANVAS_W, CANVAS_H } from "./constants.js";

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
  deleteCardsShortcut: string;
  setWarpShortcut: string;
  toggleWarpsShortcut: string;
  removeWarpShortcut: string;
  canvasWidth: number;
  canvasHeight: number;
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
  deleteCardsShortcut: "Delete",
  setWarpShortcut: "a",
  // Shift+A. Shortcuts are compared against `event.key`, which already carries the shift.
  toggleWarpsShortcut: "A",
  removeWarpShortcut: "x",
  canvasWidth: CANVAS_W,
  canvasHeight: CANVAS_H,
};

export const UI_NUM_RANGES: Partial<Record<keyof UiConfig, [number, number]>> = {
  defaultFontSize: [4, 128],
  defaultCardWidth: [40, 1200],
  defaultZoom: [0.1, 10],
  zoomStep: [0.01, 1],
  leftPanelWidth: [80, 800],
  rightPanelWidth: [80, 800],
  warpMarkerSize: [8, 64],
  canvasWidth: [400, 20000],
  canvasHeight: [400, 20000],
};

export const UI_BOOL_FIELDS = [
  "defaultShowFooter",
  "defaultShowSidePanel",
  "defaultShowWarps",
] as const;

export const NEW_CARD_PLACEMENTS = ["grid", "vertical-list"] as const;

export const UI_STR_FIELDS = [
  "defaultFontFamily",
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
  "deleteCardsShortcut",
  "setWarpShortcut",
  "toggleWarpsShortcut",
  "removeWarpShortcut",
] as const;

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
 * Validates the `ui` block of a workspace config, collecting every problem instead of
 * stopping at the first. `value` holds the fields that passed; the rest fall back to
 * their defaults. {@link parseUiOverrides} reacts to the issues, `kozane doctor config`
 * reports them.
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
  if (strict && issues.length > 0) throw new Error(`Invalid Kozane config: ${issues[0].message}`);
  return value;
}
