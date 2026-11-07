import type {
  CardWithGlue,
  PartitionWithColor,
  GlueRel,
  Inventory,
  Layer,
  ScopeArea as ScopeAreaRow,
  TaskspaceSummary,
  Warp,
} from "$lib/types";
import type { BoardRect } from "../../constants/index.js";
import type { NewCardPlacement } from "../../ui-config.js";
import type { SelectionState } from "../namespace-state.svelte.js";
import type { TaskspaceTreeContext, TaskspaceTreeState } from "./taskspace-tree.svelte.js";
import type { InventoryDrag } from "./inventory-drop.js";
import type { CardPositionPatch } from "./namespace-page.js";

/** Props of `KozaneCanvas.svelte`, the board's drawing and gesture surface. */
export type KozaneCanvasProps = {
  cards: CardWithGlue[];
  visibleCards: CardWithGlue[];
  glueRels: GlueRel[];
  layers: Layer[];
  activeLayerId: string | null;
  partitionColorById: Map<string, PartitionWithColor>;
  /**
   * Share the page's selection state as one object so selected IDs and the primary card are
   * updated together.
   */
  selection: SelectionState;
  scopeCardIds: Set<string> | null;
  /**
   * Scope frames on this board. A scope may have several frames or none. Cards inside any
   * of its frames belong to it.
   */
  scopeAreas: ScopeAreaRow[];
  /** The name each frame draws on its tab, by scope id. */
  scopeNameById: Map<string, string>;
  /** The scope the board is filtered to, whose frame is drawn at full strength. */
  activeScopeId: string | null;
  /**
   * Every taskspace this board draws, whichever scope it belongs to. Narrowed per frame by
   * `taskspacesForScope`.
   */
  taskspaces: TaskspaceSummary[];
  /**
   * Share the directory cache with the file browser and file palette so refreshes and folder
   * loads update every view.
   */
  taskspaceTree: TaskspaceTreeState;
  treeContext: TaskspaceTreeContext;
  /**
   * Opens one file of one taskspace in the editor. Absent on a board with no endpoint to
   * read a file with, where a frame's icons are drawn and inert.
   */
  onOpenFile?: (taskspaceId: string, path: string) => void;
  /**
   * Creates a taskspace directory in a scope. Absent on read-only boards, where a frame of a
   * scope with no taskspaces draws nothing beside it.
   */
  onCreateTaskspace?: (
    scopeId: string,
    name: string,
  ) => Promise<{ id: string } | { error: string }>;
  /**
   * Rectangle drawn with Alt while awaiting scope selection. Keep it visible until the page
   * accepts or cancels the prompt.
   */
  pendingScopeAreaRect: { x: number; y: number; w: number; h: number } | null;
  /**
   * Persist an optimistically moved or resized scope frame. Return false so the caller can
   * restore its previous geometry.
   */
  onPersistScopeArea: (scopeId: string, areaId: string, rect: BoardRect) => Promise<boolean>;
  /** Takes one frame off the board. The scope and its other frames are left alone. */
  onRemoveScopeArea: (scopeId: string, areaId: string) => void;
  /**
   * Files the cards that crossed a frame's edge into the scope, or out of it. Called after
   * the positions behind the crossing are saved, so a card is never filed into a scope at a
   * position the server refused.
   */
  onScopeMembershipChange: (
    scopeId: string,
    change: { entered: string[]; exited: string[] },
  ) => Promise<void>;
  /** Creation order determines each warp's number. */
  warps: Warp[];
  focusedWarpId: string | null;
  warpsVisible: boolean;
  /** Diameter of a warp marker, in canvas pixels. */
  warpMarkerSize: number;
  /**
   * Initial view position for arrivals from another namespace. Null opens at the board's
   * centre.
   */
  initialCenter?: { posX: number; posY: number } | null;
  onFocusWarp: (warpId: string) => void;
  /**
   * Persist an optimistically moved warp. Return false so the caller can restore its
   * previous position.
   */
  onPersistWarpPosition: (
    warpId: string,
    position: { posX: number; posY: number },
  ) => Promise<boolean>;
  /** Inventory icons on this board. Their cards appear in `cards` with inventory data. */
  inventories: Inventory[];
  /** Inventories whose grid is open, which draws their icon in the accent. */
  openInventoryIds: ReadonlySet<string>;
  /** Icon label using the inventory name or a numbered fallback. */
  inventoryLabel: (inventory: Inventory) => string;
  onToggleInventory: (inventoryId: string) => void;
  /** Persist an optimistically moved icon. Return false to put it back. */
  onPersistInventoryPosition: (
    inventoryId: string,
    position: { posX: number; posY: number },
  ) => Promise<boolean>;
  /** Puts cards into an inventory, on `slot` or in its first free slots when null. */
  onStow: (cardIds: string[], inventoryId: string, slot: number | null) => Promise<void>;
  /** Puts a stored card on the canvas, answering whether the server kept it there. */
  onTake: (cardId: string, position: { posX: number; posY: number }) => Promise<boolean>;
  /**
   * Report inventory drag state to the grids outside the canvas. Include the target slot,
   * dragged card, and preview position.
   */
  inventoryDrag?: InventoryDrag;
  showFooters: boolean;
  zoom: number;
  zoomStep: number;
  canvasWidth: number;
  canvasHeight: number;
  cardWidth: number;
  newCardPlacement: NewCardPlacement;
  fontSize: number;
  fontFamily: string;
  onPersistPositions: (positions: CardPositionPatch[]) => Promise<boolean>;
  onPersistWidth: (cardId: string, width: number) => Promise<boolean>;
  onPositionActivityStart: () => void;
  onPositionActivityEnd: () => void;
  onError: (message: string) => void;
  /** Passed to each card, which draws a tag in its text as a link to it. See `KozaneCard`. */
  tagHref?: (tag: string) => string;
  // A read-only export keeps pan and zoom but disables card drag, selection, and compose.
  readonly?: boolean;
};
