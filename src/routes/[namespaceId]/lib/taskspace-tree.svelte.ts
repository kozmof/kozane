import type { TaskspaceEntry, TaskspaceFileTree, TaskspaceTruncation } from "$lib/types";
import {
  createTaskspaceFile,
  createTaskspaceFolder,
  failureMessage,
  fetchTaskspaceFiles,
} from "./namespace-api.js";
import { findStaticNode, staticDirectoryEntries } from "./taskspace-static.js";

/** What is known about one directory of one taskspace. */
export type TaskspaceNode = {
  /** Null until the directory has been read once. */
  entries: TaskspaceEntry[] | null;
  /** Why the listing is not all there, or null when it is. */
  truncated: TaskspaceTruncation | null;
  loading: boolean;
  error: string | null;
};

const EMPTY_NODE: TaskspaceNode = { entries: null, truncated: null, loading: false, error: null };

export type TaskspaceCreateKind = "file" | "directory";

/** Where a name is currently being typed, and what it will become. */
export type TaskspaceCreateTarget = {
  taskspaceId: string;
  /** The directory it goes in, relative to the taskspace root. Empty is the root. */
  path: string;
  kind: TaskspaceCreateKind;
};

/** What was made, for a caller with something to do about it — opening a new file. */
export type TaskspaceCreated = {
  taskspaceId: string;
  kind: TaskspaceCreateKind;
  /** The new entry itself, relative to the taskspace root. */
  path: string;
};

export type TaskspaceTreeContext = {
  fetcher: typeof fetch;
  namespaceId: string;
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

  /**
   * The one directory currently being typed a name into, or null. One at a time, because
   * the input is drawn inside the tree at the directory it belongs to: two open at once
   * would be two carets with nothing on screen saying which the keyboard has.
   */
  creating = $state<TaskspaceCreateTarget | null>(null);
  /** Why the last attempt was refused — a name already taken, above all. */
  createError = $state<string | null>(null);
  createBusy = $state(false);

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
    if (this.creating && !alive.has(this.creating.taskspaceId)) this.cancelCreate();
  }

  reset(): void {
    this.expanded = new Set();
    this.nodes = {};
    this.cancelCreate();
  }

  /** Opens the name field in `path`, replacing one open elsewhere. */
  beginCreate(taskspaceId: string, path: string, kind: TaskspaceCreateKind): void {
    this.creating = { taskspaceId, path, kind };
    this.createError = null;
  }

  cancelCreate(): void {
    this.creating = null;
    this.createError = null;
    this.createBusy = false;
  }

  /**
   * Creates what is being typed, and answers with it so a new file can be opened in the
   * editor. Null when nothing was made, with {@link createError} saying why and the field
   * left open over what was typed — a name already taken is worth correcting rather than
   * retyping.
   *
   * `name` is one entry, not a path: a separator in it is refused here rather than sent,
   * so that what the field creates is always the thing the row it sits under will show.
   * The leading dot is refused for the same reason the server refuses it — the tree does
   * not draw dot-entries, and creating one would put a file beyond both the panel and its
   * editor the moment it existed.
   *
   * The directory it went into is re-read afterwards rather than patched from the answer,
   * so the new row arrives with the same metadata every other row has, and anything else
   * written there since the folder was opened arrives with it.
   */
  async submitCreate(ctx: TaskspaceTreeContext, name: string): Promise<TaskspaceCreated | null> {
    const target = this.creating;
    if (!target || this.createBusy) return null;

    const trimmed = name.trim();
    const what = target.kind === "file" ? "File" : "Folder";
    if (!trimmed) {
      this.createError = `${what} name is required`;
      return null;
    }
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      this.createError = `${what} name cannot contain a path separator`;
      return null;
    }
    if (trimmed.startsWith(".")) {
      this.createError = `${what} name cannot start with a dot`;
      return null;
    }

    const path = target.path ? `${target.path}/${trimmed}` : trimmed;
    this.createBusy = true;
    this.createError = null;

    try {
      const create = target.kind === "file" ? createTaskspaceFile : createTaskspaceFolder;
      const res = await create(ctx.fetcher, ctx.namespaceId, target.taskspaceId, path);
      if (!res.ok) {
        this.createError = await failureMessage(res, `Failed to create ${what.toLowerCase()}`);
        return null;
      }
    } catch {
      this.createError = `Failed to create ${what.toLowerCase()}`;
      return null;
    } finally {
      this.createBusy = false;
    }

    this.creating = null;
    this.createError = null;
    await this.load(ctx, target.taskspaceId, target.path, true);
    return { taskspaceId: target.taskspaceId, kind: target.kind, path };
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
          : { entries: [], truncated: null, loading: false, error: "Directory not found" };
      return;
    }

    // The rows already on screen are left in place while the re-read is in flight, so a
    // refresh does not blank the tree out and reflow everything under it.
    this.nodes[key] = { ...(current ?? EMPTY_NODE), loading: true, error: null };

    try {
      const res = await fetchTaskspaceFiles(ctx.fetcher, ctx.namespaceId, taskspaceId, path);
      if (!res.ok) {
        const message = await failureMessage(res, "Failed to list files");
        this.nodes[key] = { ...(this.nodes[key] ?? EMPTY_NODE), loading: false, error: message };
        return;
      }
      const body = await res.json();
      this.nodes[key] = {
        entries: Array.isArray(body?.entries) ? body.entries : [],
        // A live listing has only ever the one reason to be cut off.
        truncated: body?.truncated === true ? "entries" : null,
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
