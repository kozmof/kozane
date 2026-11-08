import {
  TASKSPACE_FILE_BYTES_MAX,
  TASKSPACE_SSG_TOTAL_BYTES_MAX,
  TASKSPACE_SSG_NODES_MAX,
} from "@kozane/core";
import type {
  TaskspaceEntry,
  TaskspaceFileNode,
  TaskspaceFileTree,
  TaskspaceTruncation,
} from "@kozane/core";

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

export const STATIC_FILE_SKIP_MESSAGES = Object.freeze({
  "too-large": "This file is too large to open.",
  "not-text": "This file is not text and cannot be opened.",
  budget: "This export's size budget ran out before reaching this file.",
  unreadable: "This file could not be read when the export was built.",
});

/** Validate embedded trees without recursing through untrusted depth or cycles. */
export function isStaticFileTree(value: unknown): value is TaskspaceFileTree {
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  if (!record(value) || !record(value.root) || value.root.kind !== "directory") return false;
  const pending: unknown[] = [value.root];
  const seen = new Set<object>();
  let contentBytes = 0;
  const encoder = new TextEncoder();
  while (pending.length) {
    const node = pending.pop();
    if (!record(node) || seen.has(node) || typeof node.name !== "string") return false;
    seen.add(node);
    // The export budget counts descendants, excluding the taskspace root.
    if (seen.size > TASKSPACE_SSG_NODES_MAX + 1) return false;
    if (node.kind === "directory") {
      if (
        !Array.isArray(node.children) ||
        ![null, "entries", "depth", "nodes", "unreadable"].includes(node.truncated as string | null)
      )
        return false;
      const names = new Set<string>();
      if (node.children.length > TASKSPACE_SSG_NODES_MAX) return false;
      for (const child of node.children) {
        if (
          !record(child) ||
          typeof child.name !== "string" ||
          child.name.length === 0 ||
          child.name === "." ||
          child.name === ".." ||
          child.name.includes("/") ||
          child.name.includes("\\") ||
          child.name.includes("\0") ||
          names.has(child.name)
        )
          return false;
        names.add(child.name);
        pending.push(child);
      }
    } else if (node.kind === "file") {
      if (
        typeof node.content !== "string" ||
        typeof node.size !== "number" ||
        !Number.isFinite(node.size) ||
        node.size < 0
      )
        return false;
      if (node.content.length > TASKSPACE_FILE_BYTES_MAX) return false;
      const bytes = encoder.encode(node.content).byteLength;
      contentBytes += bytes;
      if (bytes > TASKSPACE_FILE_BYTES_MAX || contentBytes > TASKSPACE_SSG_TOTAL_BYTES_MAX)
        return false;
    } else if (node.kind === "file-skipped") {
      if (
        typeof node.reason !== "string" ||
        !Object.hasOwn(STATIC_FILE_SKIP_MESSAGES, node.reason) ||
        !(
          node.size === null ||
          (typeof node.size === "number" && Number.isFinite(node.size) && node.size >= 0)
        )
      )
        return false;
    } else if (node.kind !== "symlink" && node.kind !== "other") return false;
  }
  return true;
}
