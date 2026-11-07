import { createNodeNavigation } from "../../navigation.js";
import type { Warp } from "$lib/types";
import type { WarpListEntry } from "../../warp-list.js";

/**
 * Exclude the focused warp once the viewport is as centered on it as canvas bounds allow.
 * Otherwise an edge warp remains ahead of the center and repeated arrow navigation keeps
 * choosing it. Panning away makes it eligible again.
 */
export function reachableWarps(
  warps: Warp[],
  focusedWarpId: string | null,
  isCenteredOn: (posX: number, posY: number) => boolean,
): Warp[] {
  const focused = warps.find(({ id }) => id === focusedWarpId);
  return focused && isCenteredOn(focused.posX, focused.posY)
    ? warps.filter(({ id }) => id !== focused.id)
    : warps;
}

/**
 * The link for a jump to a warp in another namespace. The target travels in the URL so the
 * destination page controls its viewport and the link can be shared. Preserve the current
 * route's trailing-slash style.
 */
export function crossNamespaceWarpHref(
  base: string,
  currentPathname: string,
  entry: Pick<WarpListEntry, "namespaceId" | "id">,
): string {
  return createNodeNavigation({
    base,
    boardTrailingSlash: () => currentPathname.endsWith("/"),
  }).board(entry.namespaceId, { warp: entry.id });
}
