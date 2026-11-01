/**
 * Browser clients for the namespace API, split by resource under `./api/`. Import from this
 * module so callers share one path, which is also the one tests mock.
 */
export * from "./api/request.js";
export * from "./api/cards.js";
export * from "./api/structure.js";
export * from "./api/warps.js";
export * from "./api/taskspaces.js";
export * from "./api/inventories.js";
