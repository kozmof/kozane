import type { ScopeArea } from "$lib/types";
import { clamp, SCOPE_AREA_MIN_SIZE, type BoardRect } from "$lib/constants";
import {
  membershipTransition,
  type MembershipTransition,
  type RectBounds,
  type WorldRect,
} from "./namespace-page.js";

/**
 * How scope frames on a board decide which cards belong to their scope.
 *
 * Membership is measured, not computed: a card's height is whatever its text wrapped to, so
 * only the drawn board can say which cards a rectangle covers. Every function here takes that
 * measurement as `cardIdsInRect` and does the rest — the grouping by scope, the union over a
 * scope's frames, the before-and-after — which is what lets it be tested without a DOM.
 */

/** Which cards the drawn board shows overlapping a world rectangle. */
export type CardIdsInRect = (rect: WorldRect) => Set<string>;

/** One scope whose members changed, and how. */
export type ScopeChange = { scopeId: string; change: MembershipTransition };

/** A frame's rectangle, in the shape the board's geometry helpers take. */
export function areaWorldRect(area: ScopeArea): WorldRect {
  return { x: area.posX, y: area.posY, w: area.width, h: area.height };
}

/** A frame's rectangle, in the shape the server stores and the save request sends. */
export function areaBoardRect(area: BoardRect): BoardRect {
  return { posX: area.posX, posY: area.posY, width: area.width, height: area.height };
}

export function sameBoardRect(a: BoardRect, b: BoardRect): boolean {
  return a.posX === b.posX && a.posY === b.posY && a.width === b.width && a.height === b.height;
}

/** The scopes drawn on a board, each with the frames it has there. */
export function areasByScope(areas: readonly ScopeArea[]): Map<string, ScopeArea[]> {
  const byScope = new Map<string, ScopeArea[]>();
  for (const area of areas) {
    const existing = byScope.get(area.scopeId);
    if (existing) existing.push(area);
    else byScope.set(area.scopeId, [area]);
  }
  return byScope;
}

/**
 * Which cards are inside a scope anywhere on the board — the union over its frames.
 *
 * The union makes several frames per scope behave like one membership. Asked per
 * frame instead, a card dragged out of one and into another of the same scope would read
 * as having left and joined in the same breath, and a card that merely stopped overlapping
 * one frame while still sitting inside another would be filed out of the scope it is plainly
 * still in.
 */
export function cardIdsInScope(
  areas: readonly ScopeArea[],
  cardIdsInRect: CardIdsInRect,
): Set<string> {
  const hit = new Set<string>();
  for (const area of areas) for (const id of cardIdsInRect(areaWorldRect(area))) hit.add(id);
  return hit;
}

/** Who is in each scope on the board right now, by scope id. */
export function membersByScope(
  areas: readonly ScopeArea[],
  cardIdsInRect: CardIdsInRect,
): Map<string, Set<string>> {
  return new Map(
    [...areasByScope(areas)].map(([scopeId, scopeAreas]) => [
      scopeId,
      cardIdsInScope(scopeAreas, cardIdsInRect),
    ]),
  );
}

/**
 * What crossed each scope's frames, given who was inside them before.
 *
 * Read at the end of a drag rather than tracked during it: a card belongs where it was let
 * go, and asking mid-drag would file it into every frame it was carried across on the way.
 * Only the scopes named in `membersBefore` are asked about, once each against everything they
 * cover, and scopes with nothing to report are dropped — so the common drag, one that goes
 * nowhere near a frame, produces no entries and no requests.
 */
export function scopeAreaChanges(
  areas: readonly ScopeArea[],
  membersBefore: Map<string, Set<string>>,
  cardIdsInRect: CardIdsInRect,
): ScopeChange[] {
  const changes: ScopeChange[] = [];
  for (const [scopeId, scopeAreas] of areasByScope(areas)) {
    const before = membersBefore.get(scopeId);
    if (!before) continue;
    const change = membershipTransition(before, cardIdsInScope(scopeAreas, cardIdsInRect));
    if (change.entered.length === 0 && change.exited.length === 0) continue;
    changes.push({ scopeId, change });
  }
  return changes;
}

/**
 * The rectangle a drawn frame would be stored as.
 *
 * Sized first, then placed — the order `clampRectToBounds` uses on the server, so what is
 * drawn here is what comes back from it. A draw smaller than the minimum is grown to it
 * rather than refused: the pointer said where, and how small a frame may usefully be is a
 * separate question from whether one was asked for.
 */
export function heldScopeAreaRect(
  rect: WorldRect,
  { canvasWidth, canvasHeight }: RectBounds,
): WorldRect {
  const w = clamp(rect.w, SCOPE_AREA_MIN_SIZE, canvasWidth);
  const h = clamp(rect.h, SCOPE_AREA_MIN_SIZE, canvasHeight);
  return {
    x: Math.round(clamp(rect.x, 0, Math.max(0, canvasWidth - w))),
    y: Math.round(clamp(rect.y, 0, Math.max(0, canvasHeight - h))),
    w: Math.round(w),
    h: Math.round(h),
  };
}
