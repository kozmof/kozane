export const CANVAS_W = 5600;
export const CANVAS_H = 4000;
export const CONTENT_MAX = 10_000;
export const NAME_MAX = 255;
/** Name of the default layer every project is created with. */
export const DEFAULT_LAYER_NAME = "Base";
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
