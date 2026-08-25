import type { TaskspaceEntry, TaskspaceFileTree } from "$lib/types";
import { failureMessage, fetchTaskspaceFiles } from "./project-api.js";
import { findStaticNode, staticDirectoryEntries } from "./taskspace-static.js";

/** What is known about one directory of one taskspace. */
export type TaskspaceNode = {
  /** Null until the directory has been read once. */
  entries: TaskspaceEntry[] | null;
  truncated: boolean;
  loading: boolean;
  error: string | null;
};

const EMPTY_NODE: TaskspaceNode = { entries: null, truncated: false, loading: false, error: null };

export type TaskspaceTreeContext = {
  fetcher: typeof fetch;
  projectId: string;
  /**
   * A static export's embedded taskspace trees, keyed by taskspace id. When a taskspace has
   * one, its directories are read from here instead of the live `/files` endpoint — a
   * static export has no server behind it to ask.
   */
  staticFiles?: Record<string, TaskspaceFileTree>;
};

export function nodeKey(taskspaceId: string, path: string): string {
  return `${taskspaceId}:${path}`;
}

function taskspaceOf(key: string): string {
  return key.slice(0, key.indexOf(":"));
}

/**
 * Which taskspace directories are open in the scope panel, and what was in them.
 *
 * Directories are read one at a time as they are opened, and what comes back is kept: a
 * folder closed and opened again costs nothing. Nothing re-reads on its own — the snapshot
 * poll refreshes the database, and the disk is not the database — so the panel offers a
 * refresh for picking up files written since a folder was opened.
 */
export class TaskspaceTreeState {
  expanded = $state<Set<string>>(new Set());
  nodes = $state<Record<string, TaskspaceNode>>({});

  isExpanded(taskspaceId: string, path: string): boolean {
    return this.expanded.has(nodeKey(taskspaceId, path));
  }

  node(taskspaceId: string, path: string): TaskspaceNode {
    return this.nodes[nodeKey(taskspaceId, path)] ?? EMPTY_NODE;
  }

  async toggle(ctx: TaskspaceTreeContext, taskspaceId: string, path: string): Promise<void> {
    const key = nodeKey(taskspaceId, path);
    const next = new Set(this.expanded);
    if (next.delete(key)) {
      this.expanded = next;
      return;
    }
    next.add(key);
    this.expanded = next;
    await this.load(ctx, taskspaceId, path);
  }

  /** Re-reads every directory of `taskspaceId` that is currently open. */
  async refresh(ctx: TaskspaceTreeContext, taskspaceId: string): Promise<void> {
    const open = [...this.expanded].filter((key) => taskspaceOf(key) === taskspaceId);
    await Promise.all(
      open.map((key) => this.load(ctx, taskspaceId, key.slice(taskspaceId.length + 1), true)),
    );
  }

  /** Forgets everything about taskspaces that are no longer there. */
  prune(taskspaceIds: Iterable<string>): void {
    const alive = new Set(taskspaceIds);
    const expanded = new Set([...this.expanded].filter((key) => alive.has(taskspaceOf(key))));
    if (expanded.size !== this.expanded.size) this.expanded = expanded;
    const nodes = Object.fromEntries(
      Object.entries(this.nodes).filter(([key]) => alive.has(taskspaceOf(key))),
    );
    if (Object.keys(nodes).length !== Object.keys(this.nodes).length) this.nodes = nodes;
  }

  reset(): void {
    this.expanded = new Set();
    this.nodes = {};
  }

  private async load(
    ctx: TaskspaceTreeContext,
    taskspaceId: string,
    path: string,
    force = false,
  ): Promise<void> {
    const key = nodeKey(taskspaceId, path);
    const current = this.nodes[key];
    if (current?.loading) return;
    // A directory already read stays as it is until a refresh asks for it again.
    if (!force && current?.entries) return;

    const staticTree = ctx.staticFiles?.[taskspaceId];
    if (staticTree) {
      const node = findStaticNode(staticTree, path);
      this.nodes[key] =
        node?.kind === "directory"
          ? { ...staticDirectoryEntries(node), loading: false, error: null }
          : { entries: [], truncated: false, loading: false, error: "Directory not found" };
      return;
    }

    // The rows already on screen are left in place while the re-read is in flight, so a
    // refresh does not blank the tree out and reflow everything under it.
    this.nodes[key] = { ...(current ?? EMPTY_NODE), loading: true, error: null };

    try {
      const res = await fetchTaskspaceFiles(ctx.fetcher, ctx.projectId, taskspaceId, path);
      if (!res.ok) {
        const message = await failureMessage(res, "Failed to list files");
        this.nodes[key] = { ...(this.nodes[key] ?? EMPTY_NODE), loading: false, error: message };
        return;
      }
      const body = await res.json();
      this.nodes[key] = {
        entries: Array.isArray(body?.entries) ? body.entries : [],
        truncated: body?.truncated === true,
        loading: false,
        error: null,
      };
    } catch {
      this.nodes[key] = {
        ...(this.nodes[key] ?? EMPTY_NODE),
        loading: false,
        error: "Failed to list files",
      };
    }
  }
}
