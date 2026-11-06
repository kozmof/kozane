import {
  StaticBackend,
  createDemoNavigation,
  DEFAULT_UI_CONFIG,
  type BoardPageData,
  type BoardViewProps,
  type PollLifecycle,
} from "../lib/client/index.js";
import { boardCanvasProps } from "./board-canvas-props.js";

/** Fully typed host props for rendering the public board without a router framework. */
export function boardViewProps(): BoardViewProps {
  const lifecycle: PollLifecycle = { visible: () => true, listen: () => () => {} };
  const canvas = boardCanvasProps();
  const data: BoardPageData = {
    namespace: { id: "board", name: "Standalone workspace board", isDefault: true },
    otherNamespaces: [],
    uiConfig: { ...DEFAULT_UI_CONFIG },
    warpDirectory: [],
    cards: canvas.cards.map((card) => ({ ...card })),
    partitions: [{ id: "partition", namespaceId: "board", name: "General", isDefault: true }],
    layers: canvas.layers.map((layer) => ({ ...layer })),
    glueRels: [],
    scopes: [],
    scopeRels: [],
    scopeAreas: [],
    warps: [],
    inventories: [],
    taskspaces: [],
  };
  return {
    data,
    backend: new StaticBackend({
      namespaces: [data.namespace],
      snapshots: [data],
      warpDirectories: { board: [] },
    }),
    navigation: createDemoNavigation({ base: "/demo" }),
    routing: { beforeNavigate: () => () => {}, navigate: async () => {}, replace: () => {} },
    preferences: { generation: 0, readActiveLayer: () => null, writeActiveLayer: () => {} },
    retryIntervalMs: false,
    lifecycle,
    isHidden: () => !lifecycle.visible(),
  };
}
