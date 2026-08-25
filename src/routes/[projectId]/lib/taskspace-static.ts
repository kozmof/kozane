import type { TaskspaceEntry, TaskspaceFileNode, TaskspaceFileTree } from "$lib/types";

/**
 * Walks a static export's embedded tree to the node at `path` — `""` is the taskspace root
 * itself. The counterpart to a live directory/file request, for a payload that already
 * holds the whole taskspace rather than answering one path at a time.
 */
export function findStaticNode(tree: TaskspaceFileTree, path: string): TaskspaceFileNode | undefined {
  const segments = path.split("/").filter((segment) => segment !== "");
  let node: TaskspaceFileNode = tree.root;
  for (const segment of segments) {
    if (node.kind !== "directory") return undefined;
    const next: TaskspaceFileNode | undefined = node.children.find((child) => child.name === segment);
    if (!next) return undefined;
    node = next;
  }
  return node;
}

function entryKind(node: TaskspaceFileNode): TaskspaceEntry["kind"] {
  return node.kind === "file-skipped" ? "file" : node.kind;
}

function entrySize(node: TaskspaceFileNode): number | null {
  return node.kind === "file" || node.kind === "file-skipped" ? node.size : null;
}

/**
 * A directory node's children, in the shape the live `/files` listing answers with — so
 * the tree panel can draw a static export's rows without knowing where they came from.
 * `modifiedAt` has no equivalent in an export baked from a single point in time.
 */
export function staticDirectoryEntries(
  node: Extract<TaskspaceFileNode, { kind: "directory" }>,
): { entries: TaskspaceEntry[]; truncated: boolean } {
  const entries = node.children.map(
    (child): TaskspaceEntry => ({
      name: child.name,
      kind: entryKind(child),
      size: entrySize(child),
      modifiedAt: null,
    }),
  );
  return { entries, truncated: node.truncated };
}
