import { CONTENT_MAX } from "../lib/constants.js";
import { UI_NUM_RANGES } from "../lib/ui-config.js";
import { ValidationError } from "./errors.js";

export interface ServiceContext {
  readonly contentMax: number;
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
  return Object.freeze({ contentMax });
}
