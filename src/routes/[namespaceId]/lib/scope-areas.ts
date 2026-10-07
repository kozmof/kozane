import type { ScopeArea } from "$lib/types";
import { clamp, SCOPE_AREA_MIN_SIZE, type BoardRect } from "$lib/constants";
import {
  membershipTransition,
  type MembershipTransition,
  type RectBounds,
  type WorldRect,
} from "./namespace-page.js";

/**
 * Calculate scope membership across frames using the caller's measured `cardIdsInRect`. Keep
 * grouping and transition logic independent of DOM measurement.
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
 * Union card overlap across every frame of a scope. Moving between its frames must not remove
 * membership while the card still overlaps another frame.
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
 * Compare pre-drag membership with final overlap for each named scope. Evaluate on release,
 * not during travel, and omit scopes with no changes.
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
 * Clamp drawn frame size before position to match the server. Expand valid small draws to the
 * minimum usable size.
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
