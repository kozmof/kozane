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
  /** Truncation reason, or null for a complete listing. */
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

/** Created entry returned to callers, including those opening a new file. */
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
   * Embedded taskspace trees keyed by taskspace ID. Use them instead of live directory
   * endpoints when available.
   */
  staticFiles?: Record<string, TaskspaceFileTree>;
};

/**
 * Why `name` cannot become a new entry, or null when it can. Require a single
 * non-dot-prefixed name rather than a path.
 */
function invalidName(kind: TaskspaceCreateKind, name: string): string | null {
  const trimmed = name.trim();
  const what = kind === "file" ? "File" : "Folder";
  if (!trimmed) return `${what} name is required`;
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return `${what} name cannot contain a path separator`;
  }
  if (trimmed.startsWith(".")) return `${what} name cannot start with a dot`;
  return null;
}

export function nodeKey(taskspaceId: string, path: string): string {
  return `${taskspaceId}:${path}`;
}

function taskspaceOf(key: string): string {
  return key.slice(0, key.indexOf(":"));
}

/**
 * Track open directories and cache their listings. Reopening a folder reuses its result.
 * Refresh explicitly to see disk changes because database polling does not refresh filesystem
 * data.
 */
export class TaskspaceTreeState {
  expanded = $state<Set<string>>(new Set());
  nodes = $state<Record<string, TaskspaceNode>>({});

  /**
   * Directory receiving a new entry name, or null. Allow only one name field at a time so
   * keyboard focus is unambiguous.
   */
  creating = $state<TaskspaceCreateTarget | null>(null);
  /** Reason the last creation attempt failed. */
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

  /**
   * Load a directory without changing whether it is open in the panel. Frames can share the
   * listing cache without changing panel navigation. Reuse loaded or in-flight requests
   * unless `force` requests a refresh.
   */
  async ensure(
    ctx: TaskspaceTreeContext,
    taskspaceId: string,
    path: string,
    force = false,
  ): Promise<void> {
    await this.load(ctx, taskspaceId, path, force);
  }

  /** Re-reads every directory of `taskspaceId` that is currently open. */
  async refresh(ctx: TaskspaceTreeContext, taskspaceId: string): Promise<void> {
    const open = [...this.expanded].filter((key) => taskspaceOf(key) === taskspaceId);
    await Promise.all(
      open.map((key) => this.load(ctx, taskspaceId, key.slice(taskspaceId.length + 1), true)),
    );
  }

  /** Remove cached state for taskspaces that no longer exist. */
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
   * Create the entered file or directory and return it, or leave the field open with
   * `createError` on failure.
   */
  async submitCreate(ctx: TaskspaceTreeContext, name: string): Promise<TaskspaceCreated | null> {
    const target = this.creating;
    if (!target || this.createBusy) return null;

    const invalid = invalidName(target.kind, name);
    if (invalid) {
      this.createError = invalid;
      return null;
    }

    this.createBusy = true;
    this.createError = null;
    const made = await this.#request(ctx, target, name);
    this.createBusy = false;
    if ("error" in made) {
      this.createError = made.error;
      return null;
    }

    this.creating = null;
    this.createError = null;
    await this.load(ctx, target.taskspaceId, target.path, true);
    return made;
  }

  /**
   * Create one entry without using the panel's name field, so views such as scope frames can
   * keep their own. Return the created entry, or the reason it was refused.
   */
  async create(
    ctx: TaskspaceTreeContext,
    target: TaskspaceCreateTarget,
    name: string,
  ): Promise<TaskspaceCreated | { error: string }> {
    const invalid = invalidName(target.kind, name);
    if (invalid) return { error: invalid };
    const made = await this.#request(ctx, target, name);
    if (!("error" in made)) await this.load(ctx, target.taskspaceId, target.path, true);
    return made;
  }

  /**
   * Send the create request for an already validated name. Callers refresh the parent listing
   * afterward to include current metadata and concurrent filesystem changes.
   */
  async #request(
    ctx: TaskspaceTreeContext,
    target: TaskspaceCreateTarget,
    name: string,
  ): Promise<TaskspaceCreated | { error: string }> {
    const trimmed = name.trim();
    const what = target.kind === "file" ? "file" : "folder";
    const path = target.path ? `${target.path}/${trimmed}` : trimmed;
    try {
      const create = target.kind === "file" ? createTaskspaceFile : createTaskspaceFolder;
      const res = await create(ctx.fetcher, ctx.namespaceId, target.taskspaceId, path);
      if (!res.ok) return { error: await failureMessage(res, `Failed to create ${what}`) };
    } catch {
      return { error: `Failed to create ${what}` };
    }
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
        // Live listings are truncated only by the entry limit.
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
