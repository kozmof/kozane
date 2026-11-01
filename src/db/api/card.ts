/**
 * Card operations, split by concern under `./card/`. Import from this module so callers and
 * test mocks keep one path.
 *
 * Delete cards through `composite.ts`, which also cleans up glue groups, to avoid a circular
 * import.
 */
export * from "./card/placement.js";
export * from "./card/read.js";
export * from "./card/case-update.js";
export * from "./card/create.js";
export * from "./card/update.js";
export * from "./card/stacking.js";
