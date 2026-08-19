export const CANVAS_W = 5600;
export const CANVAS_H = 4000;
export const CONTENT_MAX = 10_000;
export const NAME_MAX = 255;
/**
 * How many ids one request may name. Every batch endpoint binds a parameter per id, and the
 * position and stacking updates bind several — SQLite refuses a statement past its variable
 * limit, and builds the whole thing in memory before finding out. This sits far enough
 * under that to leave room for the widest of those statements, and far enough above any
 * real selection that reaching it means something other than a user dragging cards.
 */
export const BATCH_MAX = 2_000;
/** Name of the default layer every project is created with. */
export const DEFAULT_LAYER_NAME = "Base";
export const DEFAULT_SERVER_HOST = "127.0.0.1";
/**
 * Default port for `kozane open`. Picked to stay clear of ports popular tools take by
 * default (Vite 5173, Vite preview 4173, 3000, 8080, …) and of the Linux ephemeral range
 * (32768+), so a Kozane server and a project's own dev server can run side by side.
 */
export const DEFAULT_SERVER_PORT = 17173;
/** Default port for `kozane net ssg preview`, kept adjacent to {@link DEFAULT_SERVER_PORT}. */
export const DEFAULT_PREVIEW_PORT = 17174;
/**
 * The keys the browser UI moves between warps with, on their own and with `Shift` for the
 * warp palette. Reserved: a shortcut bound to one of these would fire alongside the jump
 * the same press makes, so `ui.*Shortcut` may not take them.
 */
export const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * How many entries one directory listing may carry. A taskspace is an ordinary directory
 * the user works in, so it may well hold a `node_modules` — a listing has to stay a
 * listing rather than become a several-megabyte answer nobody asked for. The panel says
 * so when a directory is cut off.
 */
export const TASKSPACE_DIR_ENTRIES_MAX = 500;
