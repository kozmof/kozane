import { getUiConfigForRoot, getWorkspaceUiConfig } from "../../db/internal/config.js";

/**
 * How much text one card of this workspace may hold. Sized by `ui.contentMax`, so the
 * built-in `CONTENT_MAX` default is the right answer only for a workspace that has not
 * changed it: a caller holding the constant would refuse text a workspace that raised the
 * setting means to accept, and accept text one that lowered it means to refuse.
 *
 * Split the way `canvasBounds` is, and for the same reason — the server finds its
 * workspace from the environment, the CLI has already resolved a root of its own.
 */
export function contentMax(): number {
  return getWorkspaceUiConfig().contentMax;
}

/** The same limit, for a caller that already holds the workspace root — the CLI. */
export function contentMaxForRoot(root: string): number {
  return getUiConfigForRoot(root).contentMax;
}
