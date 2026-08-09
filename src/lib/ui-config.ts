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
  canvasWidth: [400, 20000],
  canvasHeight: [400, 20000],
};

export const UI_BOOL_FIELDS = ["defaultShowFooter", "defaultShowSidePanel"] as const;

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
] as const;

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
  const reject = (message: string): void => {
    if (strict) throw new Error(`Invalid Kozane config: ${message}`);
  };

  if (ui === undefined) return {};
  if (typeof ui !== "object" || ui === null || Array.isArray(ui)) {
    reject("ui must be an object");
    return {};
  }

  const raw = ui as Record<string, unknown>;
  const parsed: Partial<UiConfig> = {};
  const accept = (field: keyof UiConfig, value: unknown): void => {
    (parsed as Record<string, unknown>)[field] = value;
  };

  for (const [field, [lo, hi]] of Object.entries(UI_NUM_RANGES)) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      reject(`ui.${field} must be a number`);
      continue;
    }
    if (value < lo || value > hi) {
      reject(`ui.${field} must be between ${lo} and ${hi}`);
      continue;
    }
    accept(field as keyof UiConfig, value);
  }

  for (const field of UI_BOOL_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      reject(`ui.${field} must be a boolean`);
      continue;
    }
    accept(field, value);
  }

  for (const field of UI_STR_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      reject(`ui.${field} must be a string`);
      continue;
    }
    accept(field, value);
  }

  const placement = raw.newCardPlacement;
  if (placement !== undefined) {
    if (NEW_CARD_PLACEMENTS.includes(placement as never)) {
      parsed.newCardPlacement = placement as NewCardPlacement;
    } else {
      reject(`ui.newCardPlacement must be "grid" or "vertical-list"`);
    }
  }

  return parsed;
}
