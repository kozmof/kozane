import { capabilityViewProps } from "./capability-view-props.js";
import { render } from "svelte/server";
import {
  EditorDocument,
  EditorSession,
  EditorSurface,
  FileEditor,
  NamespacesView,
  TagsView,
  MapView,
  BoardCanvas,
  BoardView,
  StaticBackend,
  createDemoNavigation,
  type NavigationDriver,
} from "../../packages/client/src/index.js";

import { tagDataset } from "../lib/backend/tags.fixtures.js";
import { tagsView } from "../lib/backend/views/tags.js";
import { boardViewProps } from "./board-view-props.js";
import { boardCanvasProps } from "./board-canvas-props.js";
import { mapDataset } from "./map-dataset.js";
import { mapView } from "../lib/backend/views/map.js";
import { staticEditorContext } from "./editor-context.js";

export async function renderViews() {
  const doc = new EditorDocument("Shared editor SSR\n");
  const surface = render(EditorSurface, {
    props: { doc, caret: { line: 0, column: 0 }, anchor: null },
  });
  const routing: NavigationDriver = {
    beforeNavigate: () => () => {},
    navigate: async () => {},
    replace: () => {},
  };
  const ctx = staticEditorContext(
    {
      t: {
        root: {
          kind: "directory",
          name: "",
          children: [{ kind: "file", name: "notes.md", content: "Shared editor SSR\n", size: 18 }],
          truncated: null,
        },
      },
    },
    "n",
  );
  const session = new EditorSession();
  await session.open(ctx, { taskspaceId: "t", taskspaceName: "Notes", path: "notes.md" });
  const panel = render(FileEditor, {
    props: {
      session,
      ctx,
      readonly: true,
      routing,
      onClose: () => {},
    },
  });
  const namespaces = render(NamespacesView, {
    props: {
      backend: new StaticBackend({ namespaces: [{ id: "n", name: "Research", isDefault: true }] }),
      initialNamespaces: [{ id: "n", name: "Research", isDefault: true }],
      navigation: createDemoNavigation({ base: "/demo" }),
      workspaceLabel: "Standalone workspace",
      retryIntervalMs: false,
    },
  });
  const tagData = tagDataset([
    { tag: "perf", source: { kind: "card", cardId: "ssr-card" }, excerpt: "Standalone tag result" },
  ]);
  const selection = { tag: "perf", namespaceId: null };
  const tags = render(TagsView, {
    props: {
      data: tagsView(tagData, selection),
      selection,
      navigation: createDemoNavigation({ base: "/demo" }),
      backend: new StaticBackend({ namespaces: tagData.namespaces, tags: tagData }),
      retryIntervalMs: false,
    },
  });
  const mapData = mapDataset("Standalone partition");
  const mapSelection = { namespaceId: null, tag: null, day: null };
  const map = render(MapView, {
    props: {
      data: mapView(mapData, { ...mapSelection, zoomStep: 0.05 }),
      selection: mapSelection,
      navigation: createDemoNavigation({ base: "/demo" }),
      backend: new StaticBackend({ namespaces: mapData.namespaces, map: mapData }),
      retryIntervalMs: false,
    },
  });
  const board = render(BoardCanvas, { props: boardCanvasProps() });
  const fullBoard = render(BoardView, { props: boardViewProps() });
  return {
    surface: surface.body,
    panel: panel.body,
    namespaces: namespaces.body,
    tags: tags.body,
    map: map.body,
    board: board.body,
    fullBoard: fullBoard.body,
  };
}

export function renderCapabilityViews(
  capabilities: import("../../packages/client/src/index.js").BackendCapabilities,
  lifetimeNotice?: string,
) {
  const props = capabilityViewProps(capabilities, lifetimeNotice);
  return {
    index: render(NamespacesView, { props: props.index }).body,
    board: render(BoardView, { props: props.board }).body,
  };
}
