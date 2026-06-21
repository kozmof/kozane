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
  canvasWidth: number;
  canvasHeight: number;
};

export const DEFAULT_UI_CONFIG: UiConfig = {
  defaultFontSize: 11.5,
  defaultFontFamily: "monospace",
  defaultCardWidth: 240,
  defaultZoom: 1,
  leftPanelWidth: 216,
  rightPanelWidth: 232,
  defaultShowFooter: false,
  defaultShowSidePanel: false,
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
export const UI_STR_FIELDS = ["defaultFontFamily"] as const;
