/**
 * Every tunable limit and default in Kozane, gathered.
 *
 * This was one 560-line file, and it was imported by nearly everything: the canvas's size sat
 * beside SQLite's parameter ceiling, beside the tag grammar's segment length, beside the byte
 * budget of a disk cache. One file to open for any of them — and one file touched by every
 * change to any of them, whose members had nothing to say to each other.
 *
 * It is now a directory of modules grouped by what they bound, and this is the barrel over
 * them, so nothing that imports a constant had to learn where it moved to. Import from here,
 * as everything already does; reach for `constants/<topic>.js` only when adding one, to put
 * it beside the constants it belongs with.
 *
 * The two constants defined in terms of another module's — `TAG_SCAN_DEPTH_MAX` and
 * `TAG_CACHE_FILES_MAX` — now say so with an import rather than by sitting a few hundred
 * lines below what they refer to.
 */

export * from "./constants/canvas.js";
export * from "./constants/limits.js";
export * from "./constants/workspace.js";
export * from "./constants/taskspace.js";
export * from "./constants/tag.js";
export * from "./constants/cache.js";
export * from "./constants/map.js";
