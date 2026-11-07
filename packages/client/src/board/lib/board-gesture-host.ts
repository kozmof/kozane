import type { CardWithGlue, Inventory, ScopeArea, Warp } from "@kozane/core";
import type { BoardRect } from "../../constants/index.js";
import type { SelectionState } from "../namespace-state.svelte.js";
import type { BoardPoint, CanvasViewport } from "./canvas-viewport.js";
import type { DropTarget } from "./inventory-drop.js";
import type {
  CardPositionPatch,
  MembershipTransition,
  RectBounds,
  WorldRect,
  buildGlueGroupMap,
  glueIdByCardId,
} from "./namespace-page.js";

/**
 * Board state and callbacks used by gestures. Getters read current props rather than
 * capturing stale values. Setters for `cards` and `pendingScopeAreaRect` update the page
 * bindings after rollback or frame drawing.
 */
export type BoardGestureHost = {
  readonly readonly: boolean;
  readonly el: HTMLElement;
  readonly viewport: CanvasViewport;
  readonly zoom: number;
  readonly bounds: RectBounds;
  /** Configured width for cards without a pinned width. */
  readonly cardWidth: number;
  cards: CardWithGlue[];
  readonly warps: Warp[];
  readonly inventories: Inventory[];
  readonly scopeAreas: ScopeArea[];
  readonly selection: SelectionState;
  readonly glueGroupMap: ReturnType<typeof buildGlueGroupMap>;
  readonly cardToGlue: ReturnType<typeof glueIdByCardId>;
  /** Fully opaque cards eligible for rectangle selection. */
  readonly sweepableCardIds: ReadonlySet<string>;
  pendingScopeAreaRect: WorldRect | null;
  /** Which cards the drawn board shows overlapping a world rectangle. */
  cardIdsInRect(rect: WorldRect): Set<string>;
  /** What a drag would land on at this screen point. See `inventory-drop.ts`. */
  dropTargetAt(clientX: number, clientY: number): DropTarget | null;

  readonly onPositionActivityStart: () => void;
  readonly onPositionActivityEnd: () => void;
  readonly onError: (message: string) => void;
  readonly onFocusWarp: (warpId: string) => void;
  readonly onPersistPositions: (positions: CardPositionPatch[]) => Promise<boolean>;
  readonly onPersistWidth: (cardId: string, width: number) => Promise<boolean>;
  readonly onPersistWarpPosition: (warpId: string, position: BoardPoint) => Promise<boolean>;
  readonly onToggleInventory: (inventoryId: string) => void;
  readonly onPersistInventoryPosition: (
    inventoryId: string,
    position: BoardPoint,
  ) => Promise<boolean>;
  /** Puts cards into an inventory, on `slot` or in its first free slots when null. */
  readonly onStow: (cardIds: string[], inventoryId: string, slot: number | null) => Promise<void>;
  /** Puts a stored card on the canvas, answering whether the server kept it there. */
  readonly onTake: (cardId: string, position: BoardPoint) => Promise<boolean>;
  readonly onPersistScopeArea: (
    scopeId: string,
    areaId: string,
    rect: BoardRect,
  ) => Promise<boolean>;
  readonly onScopeMembershipChange: (
    scopeId: string,
    change: MembershipTransition,
  ) => Promise<void>;
};
