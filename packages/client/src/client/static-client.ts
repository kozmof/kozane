import { createClientFeatures, type ClientFeatures } from "./capabilities.js";
import type { KozaneClient, ManagedClient } from "./contract.js";
import type { TagsViewData } from "@kozane/core";
import type { TreemapSnapshot } from "@kozane/core";
import type { WarpListEntry } from "../warp-list.js";
import type { TaskspaceFileTree } from "@kozane/core";
import {
  ClientError,
  type ClientCapabilities,
  type ClientInvalidation,
  type ClientState,
  type SnapshotData,
  type SnapshotResult,
  type SnapshotReadOptions,
  type TaskspaceLifecycleApi,
} from "./contract.js";
import { ClientSignals } from "./signals.js";
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
export interface StaticClientData {
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
    throw new ClientError("unavailable", "Invalid static export data", { cause });
  }
}
function invalid(): never {
  throw new ClientError("unavailable", "Invalid static export data");
}

/** Read embedded export data without live endpoints, polling, or writable storage. */
export class StaticClient implements ManagedClient {
  readonly kind = "static" as const;
  private readonly features: ClientFeatures;
  get capabilities(): ClientCapabilities {
    return this.features.capabilities;
  }
  private disposed = false;
  private readonly signals = new ClientSignals({ status: "ready" });
  get state(): ClientState {
    return this.signals.state;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.validators.clear();
    this.signals.transition({
      status: "unavailable",
      error: new ClientError("unavailable", "Client is disposed"),
      recovery: "reload",
    });
    this.signals.dispose();
  }
  private assertActive(): void {
    if (this.disposed) throw new ClientError("unavailable", "Client is disposed");
  }
  private readonly readOnly = async (..._args: unknown[]): Promise<never> => {
    this.assertActive();
    throw new ClientError("read_only", "This client is read-only");
  };
  readonly version = Object.freeze({ generation: 0, revision: 0 });
  private readonly data: StaticClientData;
  private readonly metadata = new Map<string, StaticNamespace>();
  private readonly snapshots = new Map<string, SnapshotData>();
  private readonly validators: SnapshotValidators;
  constructor(data: StaticClientData, options: { validatorCapacity?: number } = {}) {
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
    this.features = createClientFeatures(
      {
        writable: false,
        persistent: true,
        externalWrites: false,
        auth: false,
      },
      this.data.files !== undefined ? this.fileApi : undefined,
    );
  }

  subscribe(_listener: (event: ClientInvalidation) => void): () => void {
    return this.signals.subscribe(_listener);
  }
  subscribeState(listener: (state: ClientState) => void): () => void {
    return this.signals.subscribeState(listener);
  }
  private requireNamespace(namespaceId: string): StaticNamespace {
    this.assertActive();
    const row = this.metadata.get(namespaceId);
    if (!row) throw new ClientError("not_found", "Namespace not found");
    return row;
  }
  async snapshot(namespaceId: string, options: SnapshotReadOptions = {}): Promise<SnapshotResult> {
    options.signal?.throwIfAborted();
    this.requireNamespace(namespaceId);
    const data = this.snapshots.get(namespaceId);
    if (!data)
      throw new ClientError("unavailable", "Namespace snapshot is not included in this export");
    const result = this.validators.result(namespaceId, 0, "static", data, options.validator);
    return result.status === "changed" ? { ...result, data: copy(result.data) } : result;
  }
  readonly namespaces: KozaneClient["namespaces"] = Object.freeze<KozaneClient["namespaces"]>({
    list: async (options) => {
      options?.signal?.throwIfAborted();
      this.assertActive();
      return copy([...this.metadata.values()]);
    },
    get: async (namespaceId, options) => {
      options?.signal?.throwIfAborted();
      return copy(this.requireNamespace(namespaceId));
    },
    create: this.readOnly,
  });
  readonly cards: KozaneClient["cards"] = Object.freeze<KozaneClient["cards"]>({
    create: this.readOnly,
    update: this.readOnly,
    updatePositions: this.readOnly,
    remove: this.readOnly,
    removeOne: this.readOnly,
    move: this.readOnly,
    setLayer: this.readOnly,
    setPartition: this.readOnly,
    setStacking: this.readOnly,
    squash: this.readOnly,
  });
  readonly glues: KozaneClient["glues"] = Object.freeze<KozaneClient["glues"]>({
    create: this.readOnly,
    remove: this.readOnly,
  });
  readonly layers: KozaneClient["layers"] = Object.freeze<KozaneClient["layers"]>({
    create: this.readOnly,
    rename: this.readOnly,
    remove: this.readOnly,
    reorder: this.readOnly,
  });
  readonly partitions: KozaneClient["partitions"] = Object.freeze<KozaneClient["partitions"]>({
    create: this.readOnly,
    rename: this.readOnly,
    remove: this.readOnly,
  });
  readonly scopes: KozaneClient["scopes"] = Object.freeze<KozaneClient["scopes"]>({
    create: this.readOnly,
    rename: this.readOnly,
    remove: this.readOnly,
    addMembers: this.readOnly,
    removeMembers: this.readOnly,
    createArea: this.readOnly,
    updateArea: this.readOnly,
    removeArea: this.readOnly,
  });
  readonly warps: KozaneClient["warps"] = Object.freeze<KozaneClient["warps"]>({
    create: this.readOnly,
    update: this.readOnly,
    remove: this.readOnly,
  });
  readonly inventories: KozaneClient["inventories"] = Object.freeze<KozaneClient["inventories"]>({
    create: this.readOnly,
    update: this.readOnly,
    remove: this.readOnly,
    stow: this.readOnly,
    take: this.readOnly,
  });

  readonly tags: KozaneClient["tags"] = Object.freeze<KozaneClient["tags"]>({
    get: async (namespaceId, options) => {
      options?.signal?.throwIfAborted();
      this.assertActive();
      if (namespaceId !== undefined) this.requireNamespace(namespaceId);
      if (!this.data.tags)
        throw new ClientError("unavailable", "Tags are not included in this export");
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
  readonly map: KozaneClient["map"] = Object.freeze<KozaneClient["map"]>({
    get: async (options) => {
      options?.signal?.throwIfAborted();
      this.assertActive();
      if (!this.data.map)
        throw new ClientError("unavailable", "Map data is not included in this export");
      return copy(this.data.map);
    },
  });
  readonly warpDirectory: KozaneClient["warpDirectory"] = Object.freeze<
    KozaneClient["warpDirectory"]
  >({
    get: async (namespaceId, options) => {
      options?.signal?.throwIfAborted();
      this.requireNamespace(namespaceId);
      const directories = this.data.warpDirectories;
      const entries =
        directories && Object.hasOwn(directories, namespaceId)
          ? directories[namespaceId]
          : undefined;
      if (!entries)
        throw new ClientError("unavailable", "Warp directory is not included in this export");
      return copy([...entries]);
    },
  });

  private tree(namespaceId: string, taskspaceId: string): TaskspaceFileTree {
    this.requireNamespace(namespaceId);
    if (!this.snapshots.get(namespaceId)?.taskspaces.some((row) => row.id === taskspaceId))
      throw new ClientError("not_found", "Taskspace not found");
    const files = this.data.files;
    const tree = files && Object.hasOwn(files, taskspaceId) ? files[taskspaceId] : undefined;
    if (!tree)
      throw new ClientError("not_found", "Taskspace files are not included in this export");
    return tree;
  }
  private readonly fileApi: TaskspaceLifecycleApi = Object.freeze<TaskspaceLifecycleApi>({
    access: (namespaceId, taskspace) => {
      const browse =
        !this.disposed &&
        this.snapshots.get(namespaceId)?.taskspaces.some((row) => row.id === taskspace.id) ===
          true &&
        Object.hasOwn(this.data.files ?? {}, taskspace.id);
      return { browse, read: browse, write: false, refresh: false };
    },
    create: this.readOnly,
    rename: this.readOnly,
    remove: this.readOnly,
    createFile: this.readOnly,
    saveFile: this.readOnly,
    createDirectory: this.readOnly,
    renameEntry: this.readOnly,
    removeEntry: this.readOnly,
    readFile: async (namespaceId, taskspaceId, path, options) => {
      options?.signal?.throwIfAborted();
      this.assertActive();
      const node = findStaticNode(this.tree(namespaceId, taskspaceId), path);
      if (node?.kind === "file") return { path, content: node.content, signature: null };
      if (node?.kind === "file-skipped")
        throw new ClientError(
          node.reason === "budget" || node.reason === "too-large" ? "limit" : "unavailable",
          STATIC_FILE_SKIP_MESSAGES[node.reason],
        );
      throw new ClientError("not_found", "File not found");
    },
    list: async (namespaceId, taskspaceId, path, options) => {
      options?.signal?.throwIfAborted();
      const node = findStaticNode(this.tree(namespaceId, taskspaceId), path);
      if (node?.kind !== "directory") throw new ClientError("not_found", "Directory not found");
      const { entries, truncated } = staticDirectoryEntries(node);
      return { path, entries, truncated: truncated !== null, truncation: truncated };
    },
  });
  get taskspaces(): TaskspaceLifecycleApi | undefined {
    return this.features.taskspaces;
  }
}
