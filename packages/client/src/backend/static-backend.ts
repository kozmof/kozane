import type { KozaneBackend } from "./contract.js";
import type { TagsViewData } from "../../../kozane/src/services/tags.js";
import type { TreemapSnapshot } from "../../../kozane/src/services/map.js";
import type { WarpListEntry } from "../warp-list.js";
import type { TaskspaceFileTree } from "../../../kozane/src/lib/types.js";
import {
  BackendError,
  type BackendCapabilities,
  type BackendInvalidation,
  type BackendState,
  type SnapshotData,
  type SnapshotResult,
  type TaskspaceLifecycleApi,
} from "./contract.js";
import { SnapshotValidators } from "./snapshot-validators.js";
import { readNamespaceSnapshot } from "./decoders/snapshot-reader.js";
import { readTagsViewData } from "./decoders/tags.js";
import { readMapSnapshot } from "./decoders/map.js";
import { parseWarpEntries } from "./decoders/warp-directory.js";
import {
  findStaticNode,
  isStaticFileTree,
  staticDirectoryEntries,
  STATIC_FILE_SKIP_MESSAGES,
} from "./static-files.js";

export interface StaticNamespace {
  id: string;
  name: string;
  isDefault: boolean;
}
/** Each export entry can supply its own snapshots and equivalent build-time view datasets. */
export interface StaticBackendData {
  namespaces: readonly StaticNamespace[];
  snapshots?: readonly SnapshotData[];
  tags?: TagsViewData;
  map?: TreemapSnapshot;
  warpDirectories?: Readonly<Record<string, readonly WarpListEntry[]>>;
  files?: Readonly<Record<string, TaskspaceFileTree>>;
}
function copy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new BackendError("unavailable", "Invalid static export data", { cause });
  }
}
function invalid(): never {
  throw new BackendError("unavailable", "Invalid static export data");
}
async function readOnly(..._args: unknown[]): Promise<never> {
  throw new BackendError("read_only", "This backend is read-only");
}

/** Read embedded export data without live endpoints, polling, or writable storage. */
export class StaticBackend implements KozaneBackend {
  readonly kind = "static" as const;
  readonly capabilities: BackendCapabilities;
  readonly state: BackendState = Object.freeze({ status: "ready" });
  readonly version = Object.freeze({ generation: 0, revision: 0 });
  private readonly data: StaticBackendData;
  private readonly metadata = new Map<string, StaticNamespace>();
  private readonly snapshots = new Map<string, SnapshotData>();
  private readonly validators: SnapshotValidators;
  constructor(data: StaticBackendData, options: { validatorCapacity?: number } = {}) {
    this.validators = new SnapshotValidators(options.validatorCapacity);
    this.data = copy(data);
    if (!this.data || typeof this.data !== "object" || !Array.isArray(this.data.namespaces))
      invalid();
    if (this.data.snapshots !== undefined && !Array.isArray(this.data.snapshots)) invalid();
    for (const field of [this.data.files, this.data.warpDirectories]) {
      if (field !== undefined && (!field || typeof field !== "object" || Array.isArray(field)))
        invalid();
    }
    for (const row of this.data.namespaces) {
      if (
        !row ||
        typeof row.id !== "string" ||
        !row.id ||
        typeof row.name !== "string" ||
        typeof row.isDefault !== "boolean" ||
        this.metadata.has(row.id)
      )
        invalid();
      this.metadata.set(row.id, { id: row.id, name: row.name, isDefault: row.isDefault });
    }
    for (const value of this.data.snapshots ?? []) {
      const snapshot = readNamespaceSnapshot(value);
      if (
        !snapshot ||
        !this.metadata.has(snapshot.namespace.id) ||
        this.snapshots.has(snapshot.namespace.id)
      )
        invalid();
      this.snapshots.set(snapshot.namespace.id, snapshot);
    }
    if (this.data.tags !== undefined && !readTagsViewData(this.data.tags)) invalid();
    if (this.data.map !== undefined && !readMapSnapshot(this.data.map)) invalid();
    for (const [namespaceId, entries] of Object.entries(this.data.warpDirectories ?? {})) {
      if (!this.metadata.has(namespaceId) || !parseWarpEntries(entries)) invalid();
    }
    for (const tree of Object.values(this.data.files ?? {})) if (!isStaticFileTree(tree)) invalid();
    this.capabilities = Object.freeze({
      writable: false,
      persistent: true,
      taskspaces: this.data.files !== undefined,
      externalWrites: false,
      auth: false,
    });
  }

  subscribe(_listener: (event: BackendInvalidation) => void): () => void {
    return () => {};
  }
  subscribeState(listener: (state: BackendState) => void): () => void {
    try {
      listener(this.state);
    } catch {
      /* Match listener isolation in the other adapters. */
    }
    return () => {};
  }
  private requireNamespace(namespaceId: string): StaticNamespace {
    const row = this.metadata.get(namespaceId);
    if (!row) throw new BackendError("not_found", "Namespace not found");
    return row;
  }
  async snapshot(
    namespaceId: string,
    options: { validator?: string } = {},
  ): Promise<SnapshotResult> {
    this.requireNamespace(namespaceId);
    const data = this.snapshots.get(namespaceId);
    if (!data)
      throw new BackendError("unavailable", "Namespace snapshot is not included in this export");
    const result = this.validators.result(namespaceId, 0, "static", data, options.validator);
    return result.status === "changed" ? { ...result, data: copy(result.data) } : result;
  }
  readonly namespaces: KozaneBackend["namespaces"] = Object.freeze<KozaneBackend["namespaces"]>({
    list: async () => copy([...this.metadata.values()]),
    get: async (namespaceId) => copy(this.requireNamespace(namespaceId)),
    create: readOnly,
  });
  readonly cards: KozaneBackend["cards"] = Object.freeze<KozaneBackend["cards"]>({
    create: readOnly,
    update: readOnly,
    updatePositions: readOnly,
    remove: readOnly,
    removeOne: readOnly,
    move: readOnly,
    setLayer: readOnly,
    setPartition: readOnly,
    setStacking: readOnly,
    squash: readOnly,
  });
  readonly glues: KozaneBackend["glues"] = Object.freeze<KozaneBackend["glues"]>({
    create: readOnly,
    remove: readOnly,
  });
  readonly layers: KozaneBackend["layers"] = Object.freeze<KozaneBackend["layers"]>({
    create: readOnly,
    rename: readOnly,
    remove: readOnly,
    reorder: readOnly,
  });
  readonly partitions: KozaneBackend["partitions"] = Object.freeze<KozaneBackend["partitions"]>({
    create: readOnly,
    rename: readOnly,
    remove: readOnly,
  });
  readonly scopes: KozaneBackend["scopes"] = Object.freeze<KozaneBackend["scopes"]>({
    create: readOnly,
    rename: readOnly,
    remove: readOnly,
    addMembers: readOnly,
    removeMembers: readOnly,
    createArea: readOnly,
    updateArea: readOnly,
    removeArea: readOnly,
  });
  readonly warps: KozaneBackend["warps"] = Object.freeze<KozaneBackend["warps"]>({
    create: readOnly,
    update: readOnly,
    remove: readOnly,
  });
  readonly inventories: KozaneBackend["inventories"] = Object.freeze<KozaneBackend["inventories"]>({
    create: readOnly,
    update: readOnly,
    remove: readOnly,
    stow: readOnly,
    take: readOnly,
  });

  readonly tags: KozaneBackend["tags"] = Object.freeze<KozaneBackend["tags"]>({
    get: async (namespaceId) => {
      if (namespaceId !== undefined) this.requireNamespace(namespaceId);
      if (!this.data.tags)
        throw new BackendError("unavailable", "Tags are not included in this export");
      const data = copy(this.data.tags);
      if (namespaceId === undefined) return data;
      const index = data.index;
      const taskspaces = new Set(
        Object.entries(index.taskspaces)
          .filter(([, row]) => row?.namespaceId === namespaceId || row?.namespaceId === null)
          .map(([id]) => id),
      );
      index.hits = index.hits.filter((hit) =>
        hit.source.kind === "card"
          ? index.cardNamespaces[hit.source.cardId] === namespaceId
          : taskspaces.has(hit.source.taskspaceId),
      );
      index.cardData = Object.fromEntries(
        Object.entries(index.cardData).filter(([, row]) => row?.namespaceId === namespaceId),
      );
      index.cardNamespaces = Object.fromEntries(
        Object.entries(index.cardNamespaces).filter(([, id]) => id === namespaceId),
      );
      index.taskspaces = Object.fromEntries(
        Object.entries(index.taskspaces).filter(([id]) => taskspaces.has(id)),
      );
      index.truncated = index.truncated.filter(
        (row) =>
          taskspaces.has(row.taskspaceId) ||
          !Object.hasOwn(this.data.tags!.index.taskspaces, row.taskspaceId),
      );
      index.missing = index.missing.filter(
        (id) => taskspaces.has(id) || !Object.hasOwn(this.data.tags!.index.taskspaces, id),
      );
      data.cardPartitions = data.cardPartitions.filter(
        (row) => index.cardNamespaces[row.cardId] === namespaceId,
      );
      const partitions = new Set(data.cardPartitions.map((row) => row.partitionId));
      data.partitions = Object.fromEntries(
        Object.entries(data.partitions).filter(([id]) => partitions.has(id)),
      );
      return data;
    },
  });
  readonly map: KozaneBackend["map"] = Object.freeze<KozaneBackend["map"]>({
    get: async () => {
      if (!this.data.map)
        throw new BackendError("unavailable", "Map data is not included in this export");
      return copy(this.data.map);
    },
  });
  readonly warpDirectory: KozaneBackend["warpDirectory"] = Object.freeze<
    KozaneBackend["warpDirectory"]
  >({
    get: async (namespaceId) => {
      this.requireNamespace(namespaceId);
      const directories = this.data.warpDirectories;
      const entries =
        directories && Object.hasOwn(directories, namespaceId)
          ? directories[namespaceId]
          : undefined;
      if (!entries)
        throw new BackendError("unavailable", "Warp directory is not included in this export");
      return copy([...entries]);
    },
  });

  private tree(namespaceId: string, taskspaceId: string): TaskspaceFileTree {
    this.requireNamespace(namespaceId);
    if (!this.snapshots.get(namespaceId)?.taskspaces.some((row) => row.id === taskspaceId))
      throw new BackendError("not_found", "Taskspace not found");
    const files = this.data.files;
    const tree = files && Object.hasOwn(files, taskspaceId) ? files[taskspaceId] : undefined;
    if (!tree)
      throw new BackendError("not_found", "Taskspace files are not included in this export");
    return tree;
  }
  private readonly fileApi: TaskspaceLifecycleApi = Object.freeze<TaskspaceLifecycleApi>({
    access: (namespaceId, taskspace) => {
      const browse =
        this.snapshots.get(namespaceId)?.taskspaces.some((row) => row.id === taskspace.id) ===
          true && Object.hasOwn(this.data.files ?? {}, taskspace.id);
      return { browse, read: browse, write: false, refresh: false };
    },
    create: readOnly,
    rename: readOnly,
    remove: readOnly,
    createFile: readOnly,
    saveFile: readOnly,
    createDirectory: readOnly,
    renameEntry: readOnly,
    removeEntry: readOnly,
    readFile: async (namespaceId, taskspaceId, path, options) => {
      if (options?.signal?.aborted)
        throw new BackendError("unavailable", "File read was cancelled");
      const node = findStaticNode(this.tree(namespaceId, taskspaceId), path);
      if (node?.kind === "file") return { path, content: node.content, signature: null };
      if (node?.kind === "file-skipped")
        throw new BackendError(
          node.reason === "budget" || node.reason === "too-large" ? "limit" : "unavailable",
          STATIC_FILE_SKIP_MESSAGES[node.reason],
        );
      throw new BackendError("not_found", "File not found");
    },
    list: async (namespaceId, taskspaceId, path) => {
      const node = findStaticNode(this.tree(namespaceId, taskspaceId), path);
      if (node?.kind !== "directory") throw new BackendError("not_found", "Directory not found");
      const { entries, truncated } = staticDirectoryEntries(node);
      return { path, entries, truncated: truncated !== null, truncation: truncated };
    },
  });
  get taskspaces(): TaskspaceLifecycleApi | undefined {
    return this.capabilities.taskspaces ? this.fileApi : undefined;
  }
}
