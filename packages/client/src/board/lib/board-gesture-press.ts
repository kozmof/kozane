/**
 * Build the gesture a press opens, from the board as it is at the press. Each builder returns
 * null when the pressed thing is no longer on the board. `BoardGestures` decides whether a
 * press may open a gesture at all.
 */
import { storedCardIds } from "@kozane/core";
import { gestureOrigin } from "./gesture.js";
import type {
  AreaDragGesture,
  AreaResizeGesture,
  CardDragGesture,
  CardResizeGesture,
  InventoryDragGesture,
  StowedDragGesture,
  WarpDragGesture,
} from "./board-gesture.js";
import type { BoardGestureHost } from "./board-gesture-host.js";
import { scopeMembersOf } from "./board-gesture-release.js";
import { dragGroupIds, glueGroupIds, previousPositions } from "./namespace-page.js";
import { areaBoardRect, areaWorldRect, membersByScope } from "./scope-areas.js";

export function cardDragGesture(
  host: BoardGestureHost,
  e: MouseEvent,
  cardId: string,
): CardDragGesture | null {
  const { cards, selection, glueGroupMap, cardToGlue, viewport } = host;
  const card = cards.find((c) => c.id === cardId);
  if (!card) return null;
  // A selection can reach into an inventory, and a stored card has no place on the canvas
  // to be dragged from.
  const stored = storedCardIds(cards);
  const groupIds = dragGroupIds(glueGroupMap, cardToGlue, selection.selectedCards, cardId).filter(
    (id) => !stored.has(id),
  );
  const pressed = viewport.toWorld(e.clientX, e.clientY);
  return {
    kind: "card-drag",
    cardId,
    offsetX: pressed.x - card.posX,
    offsetY: pressed.y - card.posY,
    ...gestureOrigin(e),
    prevX: card.posX,
    prevY: card.posY,
    lastX: card.posX,
    lastY: card.posY,
    groupIds,
    groupIdSet: new Set(groupIds),
    groupPrevPositions: previousPositions(cards, groupIds),
    // Combine membership by scope across all its frames so duplicate frames cannot
    // overwrite each other's card sets.
    areaMembersBefore: membersByScope(host.scopeAreas, (rect) => host.cardIdsInRect(rect)),
    pointer: { x: e.clientX, y: e.clientY },
  };
}

export function cardResizeGesture(
  host: BoardGestureHost,
  e: MouseEvent,
  cardId: string,
): CardResizeGesture | null {
  const card = host.cards.find((c) => c.id === cardId);
  if (!card) return null;
  return {
    kind: "card-resize",
    cardId,
    startClientX: e.clientX,
    moved: false,
    startWidth: card.width ?? host.cardWidth,
    prevWidth: card.width,
    pointerX: null,
  };
}

export function areaDragGesture(
  host: BoardGestureHost,
  e: MouseEvent,
  areaId: string,
): AreaDragGesture | null {
  const area = host.scopeAreas.find((a) => a.id === areaId);
  if (!area) return null;
  // Move cards inside this frame, but compare membership across every frame of the scope.
  const cardIds = [...host.cardIdsInRect(areaWorldRect(area))];
  return {
    kind: "area-drag",
    areaId,
    scopeId: area.scopeId,
    ...gestureOrigin(e),
    prevRect: areaBoardRect(area),
    cardIds,
    cardIdSet: new Set(cardIds),
    cardPrevPositions: previousPositions(host.cards, cardIds),
    membersBefore: scopeMembersOf(host, area),
  };
}

export function areaResizeGesture(
  host: BoardGestureHost,
  e: MouseEvent,
  areaId: string,
): AreaResizeGesture | null {
  const area = host.scopeAreas.find((a) => a.id === areaId);
  if (!area) return null;
  return {
    kind: "area-resize",
    areaId,
    scopeId: area.scopeId,
    ...gestureOrigin(e),
    startRect: areaBoardRect(area),
    membersBefore: scopeMembersOf(host, area),
    pointer: null,
  };
}

export function warpDragGesture(
  host: BoardGestureHost,
  e: MouseEvent,
  warpId: string,
): WarpDragGesture | null {
  const warp = host.warps.find((w) => w.id === warpId);
  if (!warp) return null;
  const pressed = host.viewport.toWorld(e.clientX, e.clientY);
  return {
    kind: "warp-drag",
    warpId,
    offsetX: pressed.x - warp.posX,
    offsetY: pressed.y - warp.posY,
    ...gestureOrigin(e),
    prevX: warp.posX,
    prevY: warp.posY,
  };
}

export function inventoryDragGesture(
  host: BoardGestureHost,
  e: MouseEvent,
  inventoryId: string,
): InventoryDragGesture | null {
  const inventory = host.inventories.find((i) => i.id === inventoryId);
  if (!inventory) return null;
  const pressed = host.viewport.toWorld(e.clientX, e.clientY);
  return {
    kind: "inventory-drag",
    inventoryId,
    offsetX: pressed.x - inventory.posX,
    offsetY: pressed.y - inventory.posY,
    ...gestureOrigin(e),
    prevX: inventory.posX,
    prevY: inventory.posY,
    pointer: { x: e.clientX, y: e.clientY },
  };
}

export function stowedDragGesture(
  host: BoardGestureHost,
  e: MouseEvent,
  cardId: string,
): StowedDragGesture | null {
  const card = host.cards.find((c) => c.id === cardId);
  if (!card?.inventory) return null;
  return {
    kind: "stowed-drag",
    cardId,
    ...gestureOrigin(e),
    pointer: { x: e.clientX, y: e.clientY },
  };
}

/**
 * Update the selection for a click on a card. A glue group is selected and deselected as a
 * unit. Shift toggles the group, and a plain click selects only it, or clears the selection
 * when it alone is already selected.
 */
export function selectClickedCard(host: BoardGestureHost, e: MouseEvent, cardId: string): void {
  const { selection, glueGroupMap, cardToGlue } = host;
  if (selection.composerCard && selection.composerCard.id !== cardId) {
    selection.composerCard = null;
  }
  const groupIds = glueGroupIds(glueGroupMap, cardToGlue, cardId);
  if (e.shiftKey) {
    const next = new Set(selection.selectedCards);
    if (next.has(cardId)) {
      groupIds.forEach((id) => next.delete(id));
    } else {
      groupIds.forEach((id) => next.add(id));
    }
    selection.selectedCards = next;
  } else if (selection.selectedCards.has(cardId) && groupIds.length > 1) {
    selection.primarySelectedId = cardId;
  } else {
    selection.primarySelectedId = cardId;
    const allSelected =
      groupIds.every((id) => selection.selectedCards.has(id)) &&
      selection.selectedCards.size === groupIds.length;
    selection.selectedCards = allSelected ? new Set() : new Set(groupIds);
  }
}
