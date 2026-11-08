import { HttpClient, StaticClient, type SnapshotData } from "../../../client/src/client/index.js";
import type { TaskspaceFileTree } from "../lib/types.js";
import type { EditorSessionContext } from "../../../client/src/editor/index.js";

export function httpEditorContext(
  fetcher: typeof fetch,
  namespaceId = "p-1",
): EditorSessionContext {
  return {
    namespaceId,
    backend: new HttpClient({
      fetcher,
      capabilities: {
        writable: true,
        persistent: true,
        taskspaces: true,
        externalWrites: false,
        auth: false,
      },
    }),
  };
}
export function staticEditorContext(
  files: Record<string, TaskspaceFileTree>,
  namespaceId = "p-1",
): EditorSessionContext {
  const snapshot: SnapshotData = {
    namespace: { id: namespaceId },
    cards: [],
    partitions: [],
    layers: [],
    warps: [],
    inventories: [],
    scopes: [],
    scopeRels: [],
    scopeAreas: [],
    glueRels: [],
    taskspaces: Object.keys(files).map((id) => ({
      id,
      name: "Files",
      scopeId: null,
      path: null,
      pathKind: "workspace_relative",
    })),
  };
  return {
    namespaceId,
    backend: new StaticClient({
      namespaces: [{ id: namespaceId, name: "Board", isDefault: true }],
      snapshots: [snapshot],
      files,
    }),
  };
}
