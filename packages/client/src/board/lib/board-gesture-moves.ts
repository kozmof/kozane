/**
 * Per-move updates for each draggable thing on the board. `BoardGestures` calls these while a
 * gesture is open, and again with `snapToGrid` when it is released.
 */
import { CARD_WIDTH_RANGE } from "../../ui-config.js";
import { SCOPE_AREA_MIN_SIZE } from "$lib/constants";
import type {
  AreaDragGesture,
  AreaResizeGesture,
  CardDragGesture,
  CardResizeGesture,
  InventoryDragGesture,
  WarpDragGesture,
} from "./board-gesture.js";
import type { BoardGestureHost } from "./board-gesture-host.js";
import { GRID, movedRect, resizedCardWidth, resizedRect } from "./namespace-page.js";
import { areaWorldRect } from "./scope-areas.js";

// Pass narrowed gestures to movement handlers so their parameters cannot be null or the
// wrong variant.
//
// Update rows in place during pointer movement. Replacing the array would rebuild layer
// groups and update styles for every card on every move.

export function moveCard(
  host: BoardGestureHost,
  g: CardDragGesture,
  clientX: number,
  clientY: number,
  snapToGrid = false,
): void {
  const { cardId, offsetX, offsetY, groupIdSet } = g;
  const pointer = host.viewport.toWorld(clientX, clientY);
  const rawX = pointer.x - offsetX;
  const rawY = pointer.y - offsetY;
  const x = Math.max(0, snapToGrid ? Math.round(rawX / GRID) * GRID : rawX);
  const y = Math.max(0, snapToGrid ? Math.round(rawY / GRID) * GRID : rawY);
  const dx = x - g.lastX;
  const dy = y - g.lastY;
  g.lastX = x;
  g.lastY = y;
  for (const c of host.cards) {
    if (c.id === cardId) {
      c.posX = x;
      c.posY = y;
    } else if (groupIdSet.has(c.id)) {
      c.posX = Math.max(0, c.posX + dx);
      c.posY = Math.max(0, c.posY + dy);
    }
  }
}

export function resizeCard(
  host: BoardGestureHost,
  g: CardResizeGesture,
  clientX: number,
  snapToGrid = false,
): void {
  const width = resizedCardWidth({
    startWidth: g.startWidth,
    deltaX: clientX - g.startClientX,
    zoom: host.zoom,
    snapToGrid,
    range: CARD_WIDTH_RANGE,
  });
  for (const c of host.cards) {
    if (c.id !== g.cardId) continue;
    c.width = width;
    break;
  }
}

export function moveWarp(
  host: BoardGestureHost,
  g: WarpDragGesture,
  clientX: number,
  clientY: number,
): void {
  // Round and clamp warp coordinates to match stored values. Do not snap them to the card
  // grid.
  const { viewport } = host;
  const pointer = viewport.toWorld(clientX, clientY);
  const { posX, posY } = viewport.onCanvas({
    x: pointer.x - g.offsetX,
    y: pointer.y - g.offsetY,
  });
  for (const w of host.warps) {
    if (w.id !== g.warpId) continue;
    w.posX = posX;
    w.posY = posY;
    break;
  }
}

export function moveInventory(
  host: BoardGestureHost,
  g: InventoryDragGesture,
  clientX: number,
  clientY: number,
): void {
  // Rounded and clamped like a warp, and likewise not snapped to the card grid.
  const { viewport } = host;
  const pointer = viewport.toWorld(clientX, clientY);
  const { posX, posY } = viewport.onCanvas({
    x: pointer.x - g.offsetX,
    y: pointer.y - g.offsetY,
  });
  for (const inventory of host.inventories) {
    if (inventory.id !== g.inventoryId) continue;
    inventory.posX = posX;
    inventory.posY = posY;
    break;
  }
}

export function moveArea(
  host: BoardGestureHost,
  g: AreaDragGesture,
  clientX: number,
  clientY: number,
  snapToGrid = false,
): void {
  const { areaId, startClientX, startClientY, prevRect, cardIdSet, cardPrevPositions } = g;
  const area = host.scopeAreas.find((a) => a.id === areaId);
  if (!area) return;

  const { zoom } = host;
  const rawDx = (clientX - startClientX) / zoom;
  const rawDy = (clientY - startClientY) / zoom;
  // Measured from where the frame started rather than accumulated per move, so the cards
  // it carries stay exactly where they were relative to it however the pointer wanders.
  const next = movedRect(
    areaWorldRect({ ...area, ...prevRect }),
    snapToGrid ? Math.round(rawDx / GRID) * GRID : rawDx,
    snapToGrid ? Math.round(rawDy / GRID) * GRID : rawDy,
    host.bounds,
  );
  const dx = next.x - prevRect.posX;
  const dy = next.y - prevRect.posY;
  area.posX = next.x;
  area.posY = next.y;

  for (const c of host.cards) {
    if (!cardIdSet.has(c.id)) continue;
    const prev = cardPrevPositions.get(c.id);
    if (!prev) continue;
    c.posX = Math.max(0, prev.x + dx);
    c.posY = Math.max(0, prev.y + dy);
  }
}

export function resizeArea(
  host: BoardGestureHost,
  g: AreaResizeGesture,
  clientX: number,
  clientY: number,
  snapToGrid = false,
): void {
  const area = host.scopeAreas.find((a) => a.id === g.areaId);
  if (!area) return;
  const next = resizedRect({
    rect: areaWorldRect({ ...area, ...g.startRect }),
    deltaX: clientX - g.startClientX,
    deltaY: clientY - g.startClientY,
    zoom: host.zoom,
    snapToGrid,
    minSize: SCOPE_AREA_MIN_SIZE,
    bounds: host.bounds,
  });
  area.width = next.w;
  area.height = next.h;
}
