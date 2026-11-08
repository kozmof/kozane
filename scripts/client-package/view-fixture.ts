import {
  StaticClient,
  createDemoNavigation,
  createMemoryPreferences,
  type SnapshotData,
  type NavigationDriver,
} from "@kozane/client";
import {
  DEFAULT_UI_CONFIG,
  type BoardViewProps,
  type TagsPageData,
  type MapPageData,
} from "@kozane/client/ui";

/** Fresh props for each render and browser root. No browser globals during construction. */
export function createViewFixture(
  routing: NavigationDriver = {
    beforeNavigate: () => {},
    navigate: async () => {},
    replace: () => {},
  },
) {
  const namespaces = [{ id: "packed", name: "Packed workspace", isDefault: true }];
  const snapshot: SnapshotData = {
    namespace: { id: "packed" },
    partitions: [{ id: "partition", namespaceId: "packed", name: "General", isDefault: true }],
    layers: [{ id: "layer", namespaceId: "packed", name: "Base", position: 0, isDefault: true }],
    cards: [
      {
        id: "card",
        partitionId: "partition",
        layerId: "layer",
        content: "Packed board 日本語 :release",
        posX: DEFAULT_UI_CONFIG.canvasWidth / 2 - 100,
        posY: DEFAULT_UI_CONFIG.canvasHeight / 2,
        zIndex: 0,
        glueId: null,
        taskspaceId: null,
        inventory: null,
        width: null,
      },
    ],
    warps: [],
    inventories: [],
    scopes: [],
    scopeRels: [],
    scopeAreas: [],
    glueRels: [],
    taskspaces: [],
  };
  const hit = {
    tag: "release",
    source: { kind: "card" as const, cardId: "card" },
    excerpt: "Packed board 日本語 :release",
  };
  const navigation = createDemoNavigation({ base: "/packed" });
  const backend = new StaticClient({
    namespaces,
    snapshots: [snapshot],
    warpDirectories: { packed: [] },
  });
  const board: BoardViewProps = {
    data: {
      ...snapshot,
      namespace: namespaces[0],
      otherNamespaces: [],
      uiConfig: DEFAULT_UI_CONFIG,
    },
    backend,
    navigation,
    routing,
    preferences: createMemoryPreferences(),
    initialDataApplied: true,
    retryIntervalMs: false,
  };
  const tags: TagsPageData = {
    namespaceId: "packed",
    namespaces,
    tree: [
      {
        name: "release",
        tag: "release",
        own: { cards: 1, files: 0 },
        total: { cards: 1, files: 0 },
        children: [],
      },
    ],
    tag: "release",
    hits: [hit],
    cardTotal: 1,
    fileTotal: 0,
    truncated: [],
    missing: [],
    cardsTruncated: false,
    cardNamespaces: { card: "packed" },
    taskspaces: {},
    cardPartitionIds: { card: "partition" },
    partitions: { partition: { name: "General", dot: "#abc" } },
  };
  const map: MapPageData = {
    namespaceId: "packed",
    namespaces,
    drawn: namespaces,
    partitions: [
      {
        id: "partition",
        namespaceId: "packed",
        name: "General",
        isDefault: true,
        cards: 1,
        bg: "#eee",
        dot: "#abc",
      },
    ],
    scopes: [],
    tagHits: [hit],
    tagCards: {
      card: { namespaceId: "packed", partitionId: "partition", updatedDay: "2026-09-06" },
    },
    tag: null,
    day: null,
    activity: [],
    cardsTruncated: false,
    zoomStep: 0.05,
  };
  return {
    board,
    tags: { data: tags, selection: { namespaceId: "packed", tag: "release" }, navigation },
    map: { data: map, selection: { namespaceId: "packed", tag: null, day: null }, navigation },
  };
}
