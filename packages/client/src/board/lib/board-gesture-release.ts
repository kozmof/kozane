/**
 * What happens when a board gesture is released: saving the result, rolling it back on
 * failure, and updating scope membership. `BoardGestures.release` clears the gesture first
 * and then hands it here.
 */
import { tick } from "svelte";
import type { ScopeArea } from "$lib/types";
import type { BoardRect } from "$lib/constants";
import type {
  AreaDragGesture,
  AreaResizeGesture,
  BoardGesture,
  CardDragGesture,
  CardResizeGesture,
  InventoryDragGesture,
  StowedDragGesture,
  WarpDragGesture,
} from "./board-gesture.js";
import type { BoardGestureHost } from "./board-gesture-host.js";
import { moveArea, moveCard, resizeArea, resizeCard } from "./board-gesture-moves.js";
import type { DropTarget } from "./inventory-drop.js";
import {
  GRID,
  cardPositionPatches,
  glueGroupIds,
  rectsIntersect,
  revertedPositions,
  type Point,
  type WorldRect,
} from "./namespace-page.js";
import {
  areaBoardRect,
  areasByScope,
  cardIdsInScope,
  heldScopeAreaRect,
  membersByScope,
  sameBoardRect,
  scopeAreaChanges,
  type ScopeChange,
} from "./scope-areas.js";

/** Draft rectangles captured before clearing the active gesture on release. */
export type Drafts = {
  swept: WorldRect | null;
  drawn: WorldRect | null;
  target: DropTarget | null;
};

/**
 * How far inside a card the pointer sits when the card is dropped out of an inventory, in
 * world pixels. The preview is drawn at the same inset, so the card lands where it was shown.
 */
export const STOWED_GRAB_INSET = 12;

export async function settleGesture(
  host: BoardGestureHost,
  g: BoardGesture,
  drafts: Drafts,
  lastPointer: Point | null,
): Promise<void> {
  switch (g.kind) {
    case "area-draw":
      // Discard Alt-clicks that did not draw a rectangle without opening the prompt.
      if (g.moved && drafts.drawn) {
        host.pendingScopeAreaRect = heldScopeAreaRect(drafts.drawn, host.bounds);
      }
      return;
    case "marquee":
      if (g.moved && drafts.swept) selectSwept(host, drafts.swept);
      return;
    case "pan":
      return;
    case "card-drag":
      return settleCardDrag(host, g, drafts.target);
    case "warp-drag":
      return settleWarpDrag(host, g);
    case "inventory-drag":
      return settleInventoryDrag(host, g);
    case "stowed-drag":
      return settleStowedDrag(host, g, drafts.target);
    case "area-drag":
      return settleAreaDrag(host, g, lastPointer);
    case "area-resize":
      return settleAreaResize(host, g);
    case "card-resize":
      return settleCardResize(host, g);
  }
}

async function settleCardDrag(
  host: BoardGestureHost,
  g: CardDragGesture,
  target: DropTarget | null,
): Promise<void> {
  if (!g.moved) return;
  if (target?.kind === "inventory") {
    // Restore the pre-drag canvas position before storing the card so taking it out returns
    // it there. The drag has not been saved, so no server rollback is needed.
    const prev = new Map(g.groupPrevPositions).set(g.cardId, { x: g.prevX, y: g.prevY });
    for (const c of host.cards) {
      const at = prev.get(c.id);
      if (!at) continue;
      c.posX = at.x;
      c.posY = at.y;
    }
    await host.onStow([g.cardId, ...g.groupIds], target.inventoryId, target.slot);
    return;
  }
  moveCard(host, g, g.pointer.x, g.pointer.y, true);
  const positions = cardPositionPatches(host.cards, [g.cardId, ...g.groupIds]);
  // Flush the snapped card position before measuring frame coverage. A few pixels at a
  // frame edge can change membership.
  await tick();
  const areaChanges = scopeAreaChangesOf(host, g.areaMembersBefore);
  if (await host.onPersistPositions(positions)) {
    // Update scope membership only after the server accepts the card positions.
    await applyScopeAreaChanges(host, areaChanges);
    return;
  }
  host.cards = revertedPositions(
    host.cards,
    positions,
    new Map(g.groupPrevPositions).set(g.cardId, { x: g.prevX, y: g.prevY }),
  );
  host.onError("Failed to save card position");
}

async function settleWarpDrag(host: BoardGestureHost, g: WarpDragGesture): Promise<void> {
  const { warps } = host;
  const dropped = g.moved ? warps.find((w) => w.id === g.warpId) : undefined;
  if (!dropped) return;
  const sent = { posX: dropped.posX, posY: dropped.posY };
  if (await host.onPersistWarpPosition(g.warpId, sent)) return;
  // Roll back only if the marker still has the failed position. A later poll or drag may
  // have changed it.
  const current = host.warps.find((w) => w.id === g.warpId);
  if (current && current.posX === sent.posX && current.posY === sent.posY) {
    current.posX = g.prevX;
    current.posY = g.prevY;
  }
  host.onError("Failed to save warp position");
}

async function settleInventoryDrag(host: BoardGestureHost, g: InventoryDragGesture): Promise<void> {
  if (!g.moved) {
    host.onToggleInventory(g.inventoryId);
    return;
  }
  const dropped = host.inventories.find((i) => i.id === g.inventoryId);
  if (!dropped) return;
  const sent = { posX: dropped.posX, posY: dropped.posY };
  if (await host.onPersistInventoryPosition(g.inventoryId, sent)) return;
  // Only if nothing has moved it since, as for a warp.
  const current = host.inventories.find((i) => i.id === g.inventoryId);
  if (current && current.posX === sent.posX && current.posY === sent.posY) {
    current.posX = g.prevX;
    current.posY = g.prevY;
  }
  host.onError("Failed to save inventory position");
}

/**
 * Drop a card dragged out of a grid. Onto a slot or an icon it is stored there. Onto the
 * canvas it comes out under the pointer, snapped to the grid, and joins any scope frame
 * it lands in, as a card dragged into one would.
 */
async function settleStowedDrag(
  host: BoardGestureHost,
  g: StowedDragGesture,
  target: DropTarget | null,
): Promise<void> {
  if (!g.moved || !target) return;
  if (target.kind === "inventory") {
    await host.onStow([g.cardId], target.inventoryId, target.slot);
    return;
  }
  const { viewport } = host;
  const pointer = viewport.toWorld(g.pointer.x, g.pointer.y);
  const snap = (v: number) => Math.max(0, Math.round((v - STOWED_GRAB_INSET) / GRID) * GRID);
  const position = viewport.onCanvas({ x: snap(pointer.x), y: snap(pointer.y) });
  // Measured before the card is drawn, so it counts as having crossed into its frame.
  const membersBefore = membersByScope(host.scopeAreas, cardIdsInRectOf(host));
  if (!(await host.onTake(g.cardId, position))) return;
  await tick();
  await applyScopeAreaChanges(host, scopeAreaChangesOf(host, membersBefore));
}

async function settleAreaDrag(
  host: BoardGestureHost,
  g: AreaDragGesture,
  lastPointer: Point | null,
): Promise<void> {
  if (g.moved && lastPointer) {
    moveArea(host, g, lastPointer.x, lastPointer.y, true);
  }
  const dropped = g.moved ? host.scopeAreas.find((a) => a.id === g.areaId) : undefined;
  if (!dropped) return;
  const sent = areaBoardRect(dropped);
  const positions = cardPositionPatches(host.cards, g.cardIds);
  // Wait for the frame and carried cards to render before measuring membership. Their new
  // data positions must be compared with updated DOM boxes.
  await tick();
  const areaChanges = scopeAreaChangesOf(host, new Map([[g.scopeId, g.membersBefore]]));
  // Save the frame first because its carried cards should move only if the frame moves.
  let ok = await persistArea(host, dropped, sent, g.prevRect);
  if (ok && positions.length > 0) ok = await host.onPersistPositions(positions);
  if (ok) {
    // Add newly covered cards. Existing members moved with the frame, so this operation
    // removes none.
    await applyScopeAreaChanges(host, areaChanges);
    return;
  }
  for (const c of host.cards) {
    const prev = g.cardPrevPositions.get(c.id);
    if (prev) {
      c.posX = prev.x;
      c.posY = prev.y;
    }
  }
  host.onError("Failed to save card position");
}

async function settleAreaResize(host: BoardGestureHost, g: AreaResizeGesture): Promise<void> {
  if (g.moved && g.pointer) resizeArea(host, g, g.pointer.x, g.pointer.y, true);
  const resized = g.moved ? host.scopeAreas.find((a) => a.id === g.areaId) : undefined;
  if (!resized) return;
  const sent = areaBoardRect(resized);
  // Use the frame's final snapped edge to determine coverage after resizing.
  await tick();
  const areaChanges = scopeAreaChangesOf(host, new Map([[g.scopeId, g.membersBefore]]));
  // Resizing can add covered cards or remove cards no longer covered.
  if (await persistArea(host, resized, sent, g.startRect)) {
    await applyScopeAreaChanges(host, areaChanges);
  }
}

async function settleCardResize(host: BoardGestureHost, g: CardResizeGesture): Promise<void> {
  if (!g.moved || g.pointerX === null) return;
  resizeCard(host, g, g.pointerX, true);
  const sent = host.cards.find((c) => c.id === g.cardId)?.width ?? null;
  if (sent === null || (await host.onPersistWidth(g.cardId, sent))) return;
  // Roll back only if the width still matches the failed save. A later poll or resize may
  // have changed it.
  host.cards = host.cards.map((c) =>
    c.id === g.cardId && c.width === sent ? { ...c, width: g.prevWidth } : c,
  );
  host.onError("Failed to save card width");
}

// ── What a release decides ───────────────────────────────────────────────

/**
 * Select cards covered by the supplied rectangle. The gesture and draft state are cleared
 * before this async operation runs.
 */
function selectSwept(host: BoardGestureHost, rect: WorldRect): void {
  const { el, viewport, sweepableCardIds, glueGroupMap, cardToGlue, selection } = host;
  const screenRect = viewport.toScreen(rect);
  const next = new Set<string>();
  let primaryId: string | null = null;
  el.querySelectorAll<HTMLElement>("[data-card-id]").forEach((cardEl) => {
    const cardId = cardEl.dataset.cardId;
    if (!cardId || !sweepableCardIds.has(cardId)) return;
    if (!rectsIntersect(cardEl.getBoundingClientRect(), screenRect)) return;
    primaryId ??= cardId;
    // A glue group is dragged and deleted as a unit, so it is selected as one too, even
    // where that reaches onto a dimmed layer.
    glueGroupIds(glueGroupMap, cardToGlue, cardId).forEach((id) => next.add(id));
  });
  selection.selectedCards = next;
  selection.primarySelectedId = primaryId;
}

/**
 * Save the frame rectangle and restore its previous value on failure. Roll back only if no
 * later poll or drag has changed it.
 */
async function persistArea(
  host: BoardGestureHost,
  area: ScopeArea,
  sent: BoardRect,
  prev: BoardRect,
): Promise<boolean> {
  if (await host.onPersistScopeArea(area.scopeId, area.id, sent)) return true;
  const current = host.scopeAreas.find((a) => a.id === area.id);
  if (current && sameBoardRect(current, sent)) Object.assign(current, prev);
  host.onError("Failed to save scope area");
  return false;
}

async function applyScopeAreaChanges(
  host: BoardGestureHost,
  changes: ScopeChange[],
): Promise<void> {
  for (const { scopeId, change } of changes) {
    await host.onScopeMembershipChange(scopeId, change);
  }
}

// The host method as a plain function, for the `scope-areas.ts` helpers.
function cardIdsInRectOf(host: BoardGestureHost): (rect: WorldRect) => Set<string> {
  return (rect) => host.cardIdsInRect(rect);
}

function scopeAreaChangesOf(
  host: BoardGestureHost,
  membersBefore: Map<string, Set<string>>,
): ScopeChange[] {
  return scopeAreaChanges(host.scopeAreas, membersBefore, cardIdsInRectOf(host));
}

/** Cards overlapping any frame of this scope on the board. */
export function scopeMembersOf(host: BoardGestureHost, area: ScopeArea): Set<string> {
  const scopeAreas = areasByScope(host.scopeAreas).get(area.scopeId) ?? [area];
  return cardIdsInScope(scopeAreas, cardIdsInRectOf(host));
}
