import type {
  TaskspaceEntry,
  TaskspaceFileNode,
  TaskspaceFileTree,
  TaskspaceTruncation,
} from "$lib/types";

/** Find a node in an embedded export tree. An empty path names the taskspace root. */
export function findStaticNode(
  tree: TaskspaceFileTree,
  path: string,
): TaskspaceFileNode | undefined {
  const segments = path.split("/").filter((segment) => segment !== "");
  let node: TaskspaceFileNode = tree.root;
  for (const segment of segments) {
    if (node.kind !== "directory") return undefined;
    const next: TaskspaceFileNode | undefined = node.children.find(
      (child) => child.name === segment,
    );
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
 * Convert embedded directory children to the live listing shape. Exported nodes have no
 * modification timestamp.
 */
export function staticDirectoryEntries(node: Extract<TaskspaceFileNode, { kind: "directory" }>): {
  entries: TaskspaceEntry[];
  truncated: TaskspaceTruncation | null;
} {
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
