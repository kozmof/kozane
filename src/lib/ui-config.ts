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
