/** Schema defaults and stored path interpretations. */
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
