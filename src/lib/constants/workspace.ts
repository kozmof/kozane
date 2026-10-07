/**
 * What a workspace is created with, and where its server answers.
 *
 * The defaults a `kozane init` writes into a new workspace, plus the ports and host `kozane
 * open` and `kozane net ssg preview` bind unless told otherwise.
 */
/**
 * Supported interpretations of stored taskspace paths. Relative paths use the workspace root
 * for portability. Absolute paths support taskspaces outside it.
 *
 * Share this list between the database schema and path resolver.
 */
export const PATH_KINDS = ["workspace_relative", "absolute"] as const;
export type PathKind = (typeof PATH_KINDS)[number];

/** Name of the default layer every namespace is created with. */
export const DEFAULT_LAYER_NAME = "Base";
/** Name of the default partition every namespace is created with. */
export const DEFAULT_PARTITION_NAME = "General";
export const DEFAULT_SERVER_HOST = "127.0.0.1";
/**
 * Default port for `kozane open`. Picked to stay clear of ports popular tools take by
 * default (Vite 5173, Vite preview 4173, 3000, 8080, …) and of the Linux ephemeral range
 * (32768+), so a Kozane server and a project's own dev server can run side by side.
 */
export const DEFAULT_SERVER_PORT = 17173;
/** Default port for `kozane net ssg preview`, kept adjacent to {@link DEFAULT_SERVER_PORT}. */
export const DEFAULT_PREVIEW_PORT = 17174;
