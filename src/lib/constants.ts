export const CANVAS_W = 5600;
export const CANVAS_H = 4000;
export const CONTENT_MAX = 10_000;
export const NAME_MAX = 255;
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
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
