import { CONTENT_MAX, CANVAS_W, CANVAS_H } from "../lib/constants.js";
import { UI_NUM_RANGES } from "../lib/ui-config.js";
import { ValidationError } from "./errors.js";

export interface ServiceContext {
  readonly contentMax: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}
/** Match workspace numeric validation, including finite fractional overrides. */
export function createServiceContext(overrides: Partial<ServiceContext> = {}): ServiceContext {
  const contentMax = overrides.contentMax === undefined ? CONTENT_MAX : overrides.contentMax;
  const [minimum, maximum] = UI_NUM_RANGES.contentMax!;
  if (typeof contentMax !== "number" || !Number.isFinite(contentMax)) {
    throw new ValidationError("ui.contentMax must be a number");
  }
  if (contentMax < minimum || contentMax > maximum) {
    throw new ValidationError(`ui.contentMax must be between ${minimum} and ${maximum}`);
  }
  const canvasWidth = overrides.canvasWidth === undefined ? CANVAS_W : overrides.canvasWidth;
  const canvasHeight = overrides.canvasHeight === undefined ? CANVAS_H : overrides.canvasHeight;
  for (const [field, value] of [
    ["canvasWidth", canvasWidth],
    ["canvasHeight", canvasHeight],
  ] as const) {
    const [lo, hi] = UI_NUM_RANGES[field]!;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new ValidationError(`ui.${field} must be a number`);
    if (value < lo || value > hi)
      throw new ValidationError(`ui.${field} must be between ${lo} and ${hi}`);
  }
  return Object.freeze({ contentMax, canvasWidth, canvasHeight });
}
