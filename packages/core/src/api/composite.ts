/**
 * Coordinate transactional writes across tables when placing the operation in a table module
 * would create circular imports.
 *
 * Preserve related data during card deletion, squash, and partition deletion. Keep operations
 * beside their table when dependencies remain one-way.
 */
export * from "./composite/cards.js";
export * from "./composite/squash.js";
export * from "./composite/move.js";
export * from "./composite/reassign.js";
