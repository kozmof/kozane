import { httpEditorContext } from "../../../test-utils/editor-context.js";
import { vi } from "vitest";
import { SelectionState } from "../../../../../client/src/board/namespace-state.svelte.js";
import { TaskspaceTreeState } from "../../../../../client/src/board/lib/taskspace-tree.svelte.js";
import type { CardPositionPatch } from "../../../../../client/src/board/lib/namespace-page.js";
import { PALETTE } from "$lib/palette";
import type { NewCardPlacement } from "$lib/ui-config";
import type {
  PartitionWithColor,
  CardWithGlue,
  Inventory,
  Layer,
  ScopeArea as ScopeAreaRow,
  Warp,
} from "$lib/types";

/** Builders and DOM helpers shared by the KozaneCanvas tests. */

export const color = (id: string): PartitionWithColor => ({
  id,
  name: id,
  bg: PALETTE[0].bg,
  dot: PALETTE[0].dot,
  isDefault: false,
});

export const layer = (id: string, position: number): Layer => ({
  id,
  namespaceId: "p1",
  name: id,
  position,
  isDefault: position === 0,
});

export const card = (
  id: string,
  layerId: string,
  overrides: Partial<CardWithGlue> = {},
): CardWithGlue => ({
  id,
  partitionId: "b1",
  layerId,
  content: id,
  posX: 10,
  posY: 20,
  zIndex: 0,
  glueId: null,
  taskspaceId: null,
  inventory: null,
  width: null,
  ...overrides,
});

export const warp = (id: string): Warp => ({ id, namespaceId: "p1", posX: 100, posY: 100 });

/**
 * Fail unexpected directory requests. Tests with framed taskspaces must supply their own
 * listing stub.
 */
export const notFetched: typeof fetch = () => {
  throw new Error("unexpected fetch");
};

export type Overrides = Record<string, unknown>;

export function makeProps(overrides: Overrides = {}) {
  const cards = [card("c1", "l1")];
  return {
    cards,
    visibleCards: cards,
    glueRels: [],
    layers: [layer("l1", 0)],
    activeLayerId: "l1",
    partitionColorById: new Map([["b1", color("b1")]]),
    selection: new SelectionState(),
    scopeCardIds: null,
    scopeAreas: [],
    scopeNameById: new Map<string, string>(),
    activeScopeId: null,
    taskspaces: [],
    taskspaceTree: new TaskspaceTreeState(),
    treeContext: httpEditorContext(notFetched, "p1"),
    pendingScopeAreaRect: null,
    onRemoveScopeArea: vi.fn(),
    onPersistScopeArea: vi.fn(
      async (
        _scopeId: string,
        _areaId: string,
        _rect: { posX: number; posY: number; width: number; height: number },
      ) => true,
    ),
    onScopeMembershipChange: vi.fn(
      async (_scopeId: string, _change: { entered: string[]; exited: string[] }) => {},
    ),
    warps: [],
    focusedWarpId: null,
    warpsVisible: true,
    warpMarkerSize: 24,
    initialCenter: null,
    onFocusWarp: vi.fn(),
    onPersistWarpPosition: vi.fn(
      async (_warpId: string, _position: { posX: number; posY: number }) => true,
    ),
    inventories: [] as Inventory[],
    openInventoryIds: new Set<string>(),
    inventoryLabel: (inventory: Inventory) => inventory.name || "Inventory",
    onToggleInventory: vi.fn(),
    onPersistInventoryPosition: vi.fn(
      async (_inventoryId: string, _position: { posX: number; posY: number }) => true,
    ),
    onStow: vi.fn(async (_cardIds: string[], _inventoryId: string, _slot: number | null) => {}),
    onTake: vi.fn(async (_cardId: string, _position: { posX: number; posY: number }) => true),
    showFooters: true,
    zoom: 1,
    zoomStep: 0.1,
    canvasWidth: 5600,
    canvasHeight: 4000,
    cardWidth: 240,
    newCardPlacement: "grid" as NewCardPlacement,
    fontSize: 11.5,
    fontFamily: "sans-serif",
    onPersistPositions: vi.fn(async (_positions: CardPositionPatch[]) => true),
    onPersistWidth: vi.fn(async (_cardId: string, _width: number) => true),
    onPositionActivityStart: vi.fn(),
    onPositionActivityEnd: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

/** The layer wrappers, in DOM order, keyed by the id the template stamps on each. */
export function layerWrappers(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-layer-id]")];
}

export function wrapperFor(container: HTMLElement, layerId: string): HTMLElement {
  const found = layerWrappers(container).find((el) => el.dataset.layerId === layerId);
  if (!found) throw new Error(`no wrapper for layer "${layerId}"`);
  return found;
}

export const cardIdsIn = (wrapper: HTMLElement) =>
  [...wrapper.querySelectorAll<HTMLElement>("[data-card-id]")].map((el) => el.dataset.cardId);

export const down = (
  target: Element,
  clientX: number,
  clientY: number,
  init: MouseEventInit = {},
) =>
  target.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, button: 0, clientX, clientY, ...init }),
  );

export const move = (clientX: number, clientY: number) =>
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY }));

export const up = () => window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

/** Wait for persistence to settle before checking rollback. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Omit `cards`, `zoom`, and `visibleCards` because {@link CanvasBindingHarness} owns their
 * state and derivation.
 */
export function boundProps(overrides: Overrides = {}) {
  const {
    cards,
    visibleCards: _visible,
    zoom: _zoom,
    pendingScopeAreaRect: _pending,
    ...props
  } = makeProps(overrides);
  return { initialCards: cards, props };
}

export function cardEl(container: HTMLElement, id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
  if (!found) throw new Error(`no card "${id}"`);
  return found;
}

export function resizeHandle(container: HTMLElement, id: string): HTMLElement {
  const found = cardEl(container, id).querySelector<HTMLElement>("[data-resize-handle]");
  if (!found) throw new Error(`card "${id}" is not showing a resize handle`);
  return found;
}

export const scopeArea = (overrides: Partial<ScopeAreaRow> = {}): ScopeAreaRow => ({
  id: "a1",
  scopeId: "s1",
  namespaceId: "p1",
  posX: 100,
  posY: 200,
  width: 640,
  height: 480,
  ...overrides,
});

/**
 * Derive a mock rectangle from rendered styles so it moves only after Svelte flushes the DOM.
 * This detects measurements taken before the updated position is visible.
 */
export function layOutFromStyle(el: HTMLElement, w: number, h: number) {
  el.getBoundingClientRect = () => {
    const x = Number.parseFloat(el.style.left) || 0;
    const y = Number.parseFloat(el.style.top) || 0;
    return {
      left: x,
      top: y,
      right: x + w,
      bottom: y + h,
      width: w,
      height: h,
      x,
      y,
    } as DOMRect;
  };
}

/** Gives an element the box it would have if the browser had laid it out. */
export function layOut(el: Element, box: { x: number; y: number; w: number; h: number }) {
  el.getBoundingClientRect = () =>
    ({
      left: box.x,
      top: box.y,
      right: box.x + box.w,
      bottom: box.y + box.h,
      width: box.w,
      height: box.h,
      x: box.x,
      y: box.y,
    }) as DOMRect;
}

export function areaTabFor(container: HTMLElement, areaId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `[data-scope-area-id="${areaId}"] button[aria-label^="Scope area"]`,
  );
  if (!found) throw new Error(`no tab for area "${areaId}"`);
  return found;
}
