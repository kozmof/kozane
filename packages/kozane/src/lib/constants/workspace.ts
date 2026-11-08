export { PATH_KINDS, DEFAULT_LAYER_NAME, DEFAULT_PARTITION_NAME } from "@kozane/core";
export type { PathKind } from "@kozane/core";

/**
 * Default base directory for new taskspaces, relative to the workspace root.
 * `namespaceDirs` adds a namespace folder unless `namespacePaths` overrides the location.
 */
export const DEFAULT_TASKSPACE_DIR = "taskspaces";

/**
 * Default `taskspace.namespaceDirs`. When on, new taskspaces go in a folder named after their
 * namespace under `defaultDir`, unless `namespacePaths` overrides the location.
 */
export const DEFAULT_TASKSPACE_NAMESPACE_DIRS = true;
export const DEFAULT_SERVER_HOST = "127.0.0.1";
/**
 * Default port for `kozane open`. Picked to stay clear of ports popular tools take by
 * default (Vite 5173, Vite preview 4173, 3000, 8080, …) and of the Linux ephemeral range
 * (32768+), so a Kozane server and a project's own dev server can run side by side.
 */
export const DEFAULT_SERVER_PORT = 17173;
/** Default port for `kozane net ssg preview`, kept adjacent to {@link DEFAULT_SERVER_PORT}. */
export const DEFAULT_PREVIEW_PORT = 17174;
