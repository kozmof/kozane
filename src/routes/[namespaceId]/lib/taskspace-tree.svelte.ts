import type { HttpBackend } from "$lib/backend/http-backend.js";
import { BackendError } from "$lib/backend/contract.js";
import type { TaskspaceEntry, TaskspaceFileTree, TaskspaceTruncation } from "$lib/types";
import { entryNameIssue } from "$lib/entry-name";
import {
  createTaskspaceFile,
  createTaskspaceFolder,
  deleteTaskspaceEntry,
  failureMessage,
  renameTaskspaceEntry,
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
  backend?: Pick<HttpBackend, "taskspaces">;
  namespaceId: string;
  /**
   * Embedded taskspace trees keyed by taskspace ID. Use them instead of live directory
   * endpoints when available.
   */
  staticFiles?: Record<string, TaskspaceFileTree>;
};

function taskspaceApi(ctx: TaskspaceTreeContext) {
  const api = ctx.backend?.taskspaces;
  if (!api) throw new BackendError("unavailable", "Taskspaces are not available");
  return api;
}

/** Why `name` cannot become a new entry, or null when it can. See {@link entryNameIssue}. */
function invalidName(kind: TaskspaceCreateKind, name: string): string | null {
  return entryNameIssue(name.trim(), kind === "file" ? "File name" : "Folder name");
}

export function nodeKey(taskspaceId: string, path: string): string {
  return `${taskspaceId}:${path}`;
}

/** The taskspace part of a {@link nodeKey}. IDs never contain `:`, but paths may. */
function taskspaceOf(key: string): string {
  return key.slice(0, key.indexOf(":"));
}

/** The directory holding `path`. Empty is the taskspace root. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function siblingPath(path: string, name: string): string {
  const parent = parentPath(path);
  return parent ? `${parent}/${name}` : name;
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

  /**
   * The latest listing request for each directory key. A response is kept only while its
   * request is still the latest, so a re-read, rename, delete, or reset makes older ones
   * land nowhere.
   */
  #pending = new Map<string, number>();
  #nextRequest = 0;

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
    for (const key of [...this.#pending.keys()])
      if (!alive.has(taskspaceOf(key))) this.#pending.delete(key);
    if (this.creating && !alive.has(this.creating.taskspaceId)) this.cancelCreate();
  }

  reset(): void {
    this.expanded = new Set();
    this.nodes = {};
    this.#pending.clear();
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
   * Rename one entry within its directory. Keep a renamed folder's open subfolders and cached
   * listings under its new path, then re-read the parent. Return the new path or the reason.
   */
  async rename(
    ctx: TaskspaceTreeContext,
    taskspaceId: string,
    path: string,
    name: string,
  ): Promise<{ path: string } | { error: string }> {
    const trimmed = name.trim();
    const invalid = entryNameIssue(trimmed);
    if (invalid) return { error: invalid };

    let next: string;
    try {
      let body;
      if (ctx.backend) {
        body = await taskspaceApi(ctx).renameEntry(ctx.namespaceId, taskspaceId, {
          path,
          name: trimmed,
        });
      } else {
        const res = await renameTaskspaceEntry(
          ctx.fetcher,
          ctx.namespaceId,
          taskspaceId,
          path,
          trimmed,
        );
        if (!res.ok) return { error: await failureMessage(res, "Failed to rename") };
        body = await res.json().catch(() => null);
      }
      next = typeof body?.path === "string" ? body.path : siblingPath(path, trimmed);
    } catch (error) {
      return { error: error instanceof BackendError ? error.message : "Failed to rename" };
    }

    const to = nodeKey(taskspaceId, next);
    const interrupted = this.rekeySubtree(taskspaceId, path, (rest) => to + rest);
    // Folders that were still loading under the old path are read again under the new one.
    await Promise.all([
      this.load(ctx, taskspaceId, parentPath(path), true),
      ...interrupted.map((key) =>
        this.load(ctx, taskspaceId, key.slice(taskspaceId.length + 1), true),
      ),
    ]);
    return { path: next };
  }

  /**
   * Re-key what is open and cached for `path` and everything under it. `to` gets the part of
   * each key after `path` (empty for `path` itself) and answers the new key, or null to drop it.
   *
   * Requests in flight for the subtree are abandoned, since they would land under the old
   * key. An open name field moves with its directory, or closes when it is dropped. Answer
   * the new keys of moved directories that were still loading, so the caller can read them
   * again.
   */
  private rekeySubtree(
    taskspaceId: string,
    path: string,
    to: (rest: string) => string | null,
  ): string[] {
    const from = nodeKey(taskspaceId, path);
    const inSubtree = (key: string) => key === from || key.startsWith(`${from}/`);
    const next = (key: string): string | null =>
      inSubtree(key) ? to(key.slice(from.length)) : key;
    for (const key of [...this.#pending.keys()]) if (inSubtree(key)) this.#pending.delete(key);
    this.expanded = new Set(
      [...this.expanded].map(next).filter((key): key is string => key !== null),
    );
    const interrupted: string[] = [];
    this.nodes = Object.fromEntries(
      Object.entries(this.nodes).flatMap(([key, node]) => {
        const k = next(key);
        if (k === null) return [];
        if (!inSubtree(key) || !node.loading) return [[k, node]];
        interrupted.push(k);
        return [[k, { ...node, loading: false }]];
      }),
    );
    // A name field open inside the subtree follows it, or closes with nowhere to create into.
    const creating = this.creating;
    if (creating?.taskspaceId === taskspaceId) {
      const key = nodeKey(taskspaceId, creating.path);
      const moved = next(key);
      if (moved === null) this.cancelCreate();
      else if (moved !== key)
        this.creating = { ...creating, path: moved.slice(taskspaceId.length + 1) };
    }
    return interrupted;
  }

  /**
   * Delete one entry, a folder with everything under it, and forget what was cached for it.
   * Return the reason on failure.
   */
  async remove(
    ctx: TaskspaceTreeContext,
    taskspaceId: string,
    path: string,
  ): Promise<{ error: string } | null> {
    try {
      if (ctx.backend) await taskspaceApi(ctx).removeEntry(ctx.namespaceId, taskspaceId, path);
      else {
        const res = await deleteTaskspaceEntry(ctx.fetcher, ctx.namespaceId, taskspaceId, path);
        if (!res.ok) return { error: await failureMessage(res, "Failed to delete") };
      }
    } catch (error) {
      return { error: error instanceof BackendError ? error.message : "Failed to delete" };
    }

    this.rekeySubtree(taskspaceId, path, () => null);
    await this.load(ctx, taskspaceId, parentPath(path), true);
    return null;
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
      if (ctx.backend) {
        const api = taskspaceApi(ctx);
        await (target.kind === "file" ? api.createFile : api.createDirectory)(
          ctx.namespaceId,
          target.taskspaceId,
          { path },
        );
      } else {
        const create = target.kind === "file" ? createTaskspaceFile : createTaskspaceFolder;
        const res = await create(ctx.fetcher, ctx.namespaceId, target.taskspaceId, path);
        if (!res.ok) return { error: await failureMessage(res, `Failed to create ${what}`) };
      }
    } catch (error) {
      return { error: error instanceof BackendError ? error.message : `Failed to create ${what}` };
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
    // A directory already read, or being read, stays as it is until a refresh asks again. A
    // forced read replaces one in flight, which may predate the change it has to show.
    if (!force && (current?.loading || current?.entries)) return;

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
    const request = ++this.#nextRequest;
    this.#pending.set(key, request);
    /** Whether a later read, rename, delete, or reset took this directory over. */
    const superseded = () => this.#pending.get(key) !== request;

    try {
      let body;
      if (ctx.backend) {
        body = await taskspaceApi(ctx).list(ctx.namespaceId, taskspaceId, path);
      } else {
        const res = await fetchTaskspaceFiles(ctx.fetcher, ctx.namespaceId, taskspaceId, path);
        if (!res.ok) {
          const message = await failureMessage(res, "Failed to list files");
          if (superseded()) return;
          this.#pending.delete(key);
          this.nodes[key] = { ...(this.nodes[key] ?? EMPTY_NODE), loading: false, error: message };
          return;
        }
        body = await res.json();
      }
      if (superseded()) return;
      this.#pending.delete(key);
      this.nodes[key] = {
        entries: Array.isArray(body?.entries) ? body.entries : [],
        // Static listings retain depth, node-budget and read-failure reasons.
        truncated:
          body?.truncation === "depth" ||
          body?.truncation === "nodes" ||
          body?.truncation === "unreadable" ||
          body?.truncation === "entries"
            ? body.truncation
            : body?.truncated === true
              ? "entries"
              : null,
        loading: false,
        error: null,
      };
    } catch (error) {
      if (superseded()) return;
      this.#pending.delete(key);
      this.nodes[key] = {
        ...(this.nodes[key] ?? EMPTY_NODE),
        loading: false,
        error: error instanceof BackendError ? error.message : "Failed to list files",
      };
    }
  }
}
