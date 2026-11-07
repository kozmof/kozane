/** Where the view is centred, and which warp an arrow key moves to. */
import { clamp } from "../../../constants/index.js";
import { type Point } from "./geometry.js";

/** The world coordinate the viewport is centred on, along one axis. */
export function viewCenterWorld(scroll: number, viewportSize: number, zoom: number): number {
  return (scroll + viewportSize / 2) / zoom;
}

/** The scroll offset that puts `center` in the middle of the viewport, along one axis. */
export function scrollForViewCenter(
  center: number,
  viewportSize: number,
  zoom: number,
  maxScroll: number,
): number {
  return clamp(center * zoom - viewportSize / 2, 0, Math.max(0, maxScroll));
}

/** How far a scroll offset may sit from the one asked for and still count as arrived. */
const SCROLL_EPSILON = 1;

/**
 * Check whether `scroll` centres the target as closely as canvas bounds allow on one axis.
 * Use {@link scrollForViewCenter} and pixel rounding because edge targets cannot reach the
 * viewport centre and browsers may round scroll offsets.
 */
export function isViewCenteredOn(
  scroll: number,
  center: number,
  viewportSize: number,
  zoom: number,
  maxScroll: number,
): boolean {
  return (
    Math.abs(scroll - scrollForViewCenter(center, viewportSize, zoom, maxScroll)) <= SCROLL_EPSILON
  );
}

export type WarpDirection = "left" | "right" | "up" | "down";

/** Arrow keys, as data, so the key-to-direction step is testable outside the component. */
export const ARROW_DIRECTIONS: Record<string, WarpDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** Below this many world pixels a warp counts as being where the view already is. */
const WARP_EPSILON = 1;

/**
 * How far off the travelled axis a warp may sit before a nearer-but-sideways one loses.
 * Pressing `→` should reach the warp just to the right rather than the one far right and
 * far down, so distance across the direction costs double distance along it.
 */
const CROSS_AXIS_PENALTY = 2;

/**
 * Find the next warp in `direction`, wrapping to the opposite side when needed. Avoid
 * wrapping to `currentId` when another warp is available. Return null only for an empty
 * namespace.
 */
export function warpInDirection<T extends { id: string; posX: number; posY: number }>(
  warps: readonly T[],
  from: Point,
  direction: WarpDirection,
  currentId: string | null = null,
): T | null {
  return (
    nearestWarpInDirection(warps, from, direction) ??
    farthestWarpBehind(warps, direction, currentId)
  );
}

/**
 * Choose the opposite-edge warp when navigation wraps, breaking ties by creation order.
 * Exclude the focused warp unless it is the only candidate.
 */
function farthestWarpBehind<T extends { id: string; posX: number; posY: number }>(
  warps: readonly T[],
  direction: WarpDirection,
  currentId: string | null,
): T | null {
  const others = currentId === null ? warps : warps.filter(({ id }) => id !== currentId);
  const candidates = others.length > 0 ? others : warps;
  const horizontal = direction === "left" || direction === "right";
  // Going right restarts from the smallest x, going left from the largest.
  const sign = direction === "right" || direction === "down" ? 1 : -1;
  const along = (warp: T) => (horizontal ? warp.posX : warp.posY);
  let best: T | null = null;
  for (const warp of candidates) {
    if (best === null || sign * (along(warp) - along(best)) < 0) best = warp;
  }
  return best;
}

/**
 * Find the closest warp in the requested direction, favoring straight-ahead travel. Return
 * null when none exists so {@link warpInDirection} can wrap.
 */
export function nearestWarpInDirection<T extends { id: string; posX: number; posY: number }>(
  warps: readonly T[],
  from: Point,
  direction: WarpDirection,
): T | null {
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "right" || direction === "down" ? 1 : -1;

  let best: T | null = null;
  let bestScore = Infinity;
  let bestCross = Infinity;
  for (const warp of warps) {
    const along = sign * (horizontal ? warp.posX - from.x : warp.posY - from.y);
    if (along <= WARP_EPSILON) continue;
    const cross = Math.abs(horizontal ? warp.posY - from.y : warp.posX - from.x);
    const score = along + CROSS_AXIS_PENALTY * cross;
    // Break ties by the straighter direction, then creation order for consistent results.
    if (score < bestScore || (score === bestScore && cross < bestCross)) {
      best = warp;
      bestScore = score;
      bestCross = cross;
    }
  }
  return best;
}
