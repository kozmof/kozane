import { NamespaceState, type BoardCanvasProps } from "../../../client/src/board/index.js";
import { StaticBackend, type SnapshotData } from "../../../client/src/backend/index.js";
import { createDemoNavigation } from "../../../client/src/navigation.js";

/** Initialize the public canvas without a route, storage, fetch, or test-runner globals. */
export function boardCanvasProps(): BoardCanvasProps {
  const state = new NamespaceState({
    generation: 0,
    readActiveLayer: () => null,
    writeActiveLayer: () => {},
  });
  const snapshot: SnapshotData = {
    namespace: { id: "board" },
    cards: [
      {
        id: "card",
        partitionId: "partition",
        layerId: "layer",
        content: "Standalone board :shared",
        posX: 100,
        posY: 100,
        zIndex: 0,
        width: null,
        taskspaceId: null,
        inventory: null,
        glueId: null,
      },
    ],
    partitions: [{ id: "partition", namespaceId: "board", name: "General", isDefault: true }],
    layers: [{ id: "layer", namespaceId: "board", name: "Base", isDefault: true, position: 0 }],
    glueRels: [],
    scopes: [],
    scopeRels: [],
    scopeAreas: [],
    warps: [],
    inventories: [],
    taskspaces: [],
  };
  state.resetFromData(snapshot);
  const backend = new StaticBackend({
    namespaces: [{ id: "board", name: "Board", isDefault: true }],
  });
  const navigation = createDemoNavigation({ base: "/demo" });
  return {
    cards: state.cards,
    visibleCards: state.cards,
    glueRels: state.glueRels,
    layers: state.layers,
    activeLayerId: state.activeLayerId,
    partitionColorById: new Map([
      [
        "partition",
        { id: "partition", name: "General", isDefault: true, bg: "#eee", dot: "#123456" },
      ],
    ]),
    selection: state.selection,
    scopeCardIds: null,
    scopeAreas: [],
    scopeNameById: new Map(),
    activeScopeId: null,
    taskspaces: [],
    taskspaceTree: state.taskspaceTree,
    treeContext: { backend, namespaceId: "board" },
    pendingScopeAreaRect: null,
    onRemoveScopeArea: () => {},
    onPersistScopeArea: async () => false,
    onScopeMembershipChange: async () => {},
    warps: [],
    focusedWarpId: null,
    warpsVisible: true,
    warpMarkerSize: 24,
    onFocusWarp: () => {},
    onPersistWarpPosition: async () => false,
    inventories: [],
    openInventoryIds: new Set(),
    inventoryLabel: (row) => row.name,
    onToggleInventory: () => {},
    onPersistInventoryPosition: async () => false,
    onStow: async () => {},
    onTake: async () => false,
    showFooters: true,
    zoom: 1,
    zoomStep: 0.1,
    canvasWidth: 5600,
    canvasHeight: 4000,
    cardWidth: 240,
    newCardPlacement: "grid",
    fontSize: 12,
    fontFamily: "sans-serif",
    onPersistPositions: async () => false,
    onPersistWidth: async () => false,
    onPositionActivityStart: () => {},
    onPositionActivityEnd: () => {},
    onError: () => {},
    tagHref: (tag) => navigation.tags({ namespaceId: "board", tag }),
    readonly: true,
  };
}
