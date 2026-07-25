import { CANVAS_W, CANVAS_H } from "./constants.js";

export type UiConfig = {
  defaultFontSize: number;
  defaultFontFamily: string;
  defaultCardWidth: number;
  defaultZoom: number;
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
  defaultZoom: 1,
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
  leftPanelWidth: [80, 800],
  rightPanelWidth: [80, 800],
  canvasWidth: [400, 20000],
  canvasHeight: [400, 20000],
};

export const UI_BOOL_FIELDS = ["defaultShowFooter", "defaultShowSidePanel"] as const;
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
