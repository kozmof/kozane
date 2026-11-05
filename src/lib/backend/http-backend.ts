import type { KozaneBackend, MutationOptions } from "./contract.js";
export type { MutationOptions } from "./contract.js";
import type { TaskspaceLifecycleApi } from "./contract.js";
import { WorkspacePoller, browserPollLifecycle, type PollLifecycle } from "./workspace-poller.js";
import { readNamespaceList, readNamespaceMetadata } from "./decoders/namespaces.js";
import { parseWarpEntries } from "./decoders/warp-directory.js";
import {
  readTaskspaceCreated,
  readTaskspaceRenamed,
  readTaskspaceRemoved,
  readTaskspaceFile,
  readTaskspaceEntryResult,
  readTaskspaceListing,
} from "./decoders/taskspaces.js";
import {
  readMutationOk,
  readCreatedId,
  readNamespaceCreated,
  readLayerCreated,
  readLayerRemoved,
  readPartitionRemoved,
} from "./decoders/structure.js";
import { readScopeRenamed, readScopeAreaResult, readWarpResult } from "./decoders/geometry.js";
import { readTagsViewData } from "./decoders/tags.js";
import { readMapSnapshot } from "./decoders/map.js";
import type * as inventoriesServices from "../../services/inventories.js";
import type * as gluesServices from "../../services/glues.js";
import { SnapshotValidators } from "./snapshot-validators.js";
import { readNamespaceSnapshot } from "./decoders/snapshot-reader.js";
import type { SnapshotResult } from "./contract.js";
import type * as CardServices from "../../services/cards.js";
import { BackendError, type BackendCapabilities, type BackendDataset } from "./contract.js";
import { BackendSignals } from "./signals.js";
import { HttpTransport, type HttpTransportOptions } from "./http-transport.js";

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
const ALL: readonly BackendDataset[] = ["snapshot", "tags", "map", "namespaces", "warpDirectory"];

/** HTTP implementation of the shared backend data and lifecycle contract. */
export class HttpBackend implements KozaneBackend {
  readonly kind = "http" as const;
  readonly capabilities: BackendCapabilities;
  private readonly signals = new BackendSignals({ status: "ready" });
  private readonly transport: HttpTransport;
  private readonly poller?: WorkspacePoller;
  constructor(
    options: HttpTransportOptions & {
      base?: string;
      capabilities: BackendCapabilities;
      lifecycle?: PollLifecycle;
      pollingInitialDelayMs?: number;
    },
  ) {
    this.capabilities = Object.freeze({ ...options.capabilities });
    this.transport = new HttpTransport((path) => `${options.base ?? ""}${path}`, options);
    if (this.capabilities.externalWrites)
      this.poller = new WorkspacePoller({
        lifecycle: options.lifecycle ?? browserPollLifecycle(),
        initialDelayMs: options.pollingInitialDelayMs,
        throttleMs: () => this.transport.retryAfterMs,
        token: async () => {
          const value = await this.read<{ token?: unknown }>("/api/changes");
          if (typeof value.token !== "string" || !value.token)
            throw new BackendError("unavailable", "Invalid change token");
          return value.token;
        },
        changed: () => this.signals.publish(ALL),
        filesystemRefresh: () => {
          if (this.capabilities.taskspaces) this.signals.publish(["tags", "snapshot"]);
        },
      });
  }
  get version() {
    return this.signals.version;
  }
  get state() {
    return this.signals.state;
  }
  subscribe: BackendSignals["subscribe"] = (listener) => {
    const unsubscribe = this.signals.subscribe(listener);
    const release = this.poller?.retain();
    return () => {
      unsubscribe();
      release?.();
    };
  };
  subscribeState: BackendSignals["subscribeState"] = (listener) =>
    this.signals.subscribeState(listener);
  private ns(namespaceId: string, path: string) {
    return `/${encodeURIComponent(namespaceId)}/api${path}`;
  }
  private async read<T>(
    path: string,
    options?: { signal?: AbortSignal; cache?: RequestInit["cache"] },
  ): Promise<T> {
    const response = await this.transport.request(path, "GET", undefined, options);
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new BackendError("unavailable", "Invalid backend response", { cause });
    }
  }
  private async write<T>(
    path: string,
    method: string,
    input?: unknown,
    options?: MutationOptions,
  ): Promise<T> {
    if (!this.capabilities.writable)
      throw new BackendError("read_only", "This backend is read-only");
    const response = await this.transport.request(path, method, input, options);
    // The HTTP mutation committed even if its response body cannot be decoded.
    this.signals.publish(ALL);
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new BackendError("unavailable", "Invalid backend response", { cause });
    }
  }
  private checked<T>(
    value: unknown,
    decode: (value: unknown) => T | null,
    message = "Invalid taskspace response",
  ): T {
    const result = decode(value);
    if (result === null) throw new BackendError("unavailable", message);
    return result;
  }
  private async readTaskspace<T>(
    path: string,
    decode: (value: unknown) => T | null,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    return this.checked(await this.read<unknown>(path, options), decode);
  }
  private async writeTaskspace<T>(
    path: string,
    method: string,
    input: unknown,
    decode: (value: unknown) => T | null,
    options?: MutationOptions,
  ): Promise<T> {
    // Preserve committed invalidation even when a successful response has malformed fields.
    return this.checked(await this.write<unknown>(path, method, input, options), decode);
  }
  private async writeDomain<T>(
    path: string,
    method: string,
    input: unknown,
    decode: (value: unknown) => T | null,
    options?: MutationOptions,
  ): Promise<T> {
    return this.checked(
      await this.write<unknown>(path, method, input, options),
      decode,
      "Invalid mutation response",
    );
  }
  readonly namespaces: KozaneBackend["namespaces"] = {
    list: async () => {
      const result = readNamespaceList(await this.read<unknown>("/api/namespaces"));
      if (!result) throw new BackendError("unavailable", "Invalid namespace list");
      return result;
    },
    get: async (namespaceId: string) => {
      const result = readNamespaceMetadata(
        await this.read<unknown>(`/api/namespaces/${encodeURIComponent(namespaceId)}`),
      );
      if (!result || result.id !== namespaceId)
        throw new BackendError("unavailable", "Invalid namespace metadata");
      return result;
    },
    create: (input: { name: string }) =>
      this.writeDomain("/api/namespaces", "POST", input, readNamespaceCreated),
  };
  readonly cards: KozaneBackend["cards"] = {
    create: (ns: string, input, options?: MutationOptions) =>
      this.write<Result<typeof CardServices.create>>(this.ns(ns, "/cards"), "POST", input, options),
    update: (ns: string, id: string, input, options?: MutationOptions) =>
      this.write<Result<typeof CardServices.update>>(
        this.ns(ns, `/cards/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        options,
      ),
    updatePositions: (ns: string, input, options?: MutationOptions) =>
      this.write<Result<typeof CardServices.updatePositions>>(
        this.ns(ns, "/cards"),
        "PATCH",
        input,
        options,
      ),
    remove: (ns: string, input) =>
      this.write<Result<typeof CardServices.remove>>(this.ns(ns, "/cards"), "DELETE", input),
    removeOne: (ns: string, id: string) =>
      this.write<Result<typeof CardServices.removeOne>>(
        this.ns(ns, `/cards/${encodeURIComponent(id)}`),
        "DELETE",
      ),
    move: (ns: string, input) =>
      this.write<Result<typeof CardServices.move>>(this.ns(ns, "/cards/move"), "POST", input),
    setLayer: (ns: string, input) =>
      this.write<Result<typeof CardServices.setLayer>>(this.ns(ns, "/cards/layer"), "PATCH", input),
    setPartition: (ns: string, input) =>
      this.write<Result<typeof CardServices.setPartition>>(
        this.ns(ns, "/cards/partition"),
        "PATCH",
        input,
      ),
    setStacking: (ns: string, input) =>
      this.write<Result<typeof CardServices.setStacking>>(
        this.ns(ns, "/cards/stacking"),
        "PATCH",
        input,
      ),
    squash: (ns: string, input) =>
      this.write<Result<typeof CardServices.squash>>(this.ns(ns, "/cards/squash"), "POST", input),
  };

  readonly glues: KozaneBackend["glues"] = {
    create: (ns: string, input, options?: MutationOptions) =>
      this.write<Result<typeof gluesServices.create>>(
        this.ns(ns, "/glues"),
        "POST",
        input,
        options,
      ),
    remove: (ns: string, input, options?: MutationOptions) =>
      this.write<Result<typeof gluesServices.remove>>(
        this.ns(ns, "/glues"),
        "DELETE",
        input,
        options,
      ),
  };

  readonly layers: KozaneBackend["layers"] = {
    create: (ns: string, input, options?: MutationOptions) =>
      this.writeDomain(this.ns(ns, "/layers"), "POST", input, readLayerCreated, options),
    rename: (ns: string, id: string, input, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/layers/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        readMutationOk,
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/layers/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readLayerRemoved,
        options,
      ),
    reorder: (ns: string, input, options?: MutationOptions) =>
      this.writeDomain(this.ns(ns, "/layers"), "PATCH", input, readMutationOk, options),
  };

  readonly partitions: KozaneBackend["partitions"] = {
    create: (ns: string, input, options?: MutationOptions) =>
      this.writeDomain(this.ns(ns, "/partitions"), "POST", input, readCreatedId, options),
    rename: (ns: string, id: string, input, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/partitions/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        readMutationOk,
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/partitions/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readPartitionRemoved,
        options,
      ),
  };

  readonly scopes: KozaneBackend["scopes"] = {
    create: (ns: string, input, options?: MutationOptions) =>
      this.writeDomain(this.ns(ns, "/scopes"), "POST", input, readCreatedId, options),
    rename: (ns: string, id: string, input, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        (value) => readScopeRenamed(value, id),
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readMutationOk,
        options,
      ),
    addMembers: (ns: string, id: string, input, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/members`),
        "POST",
        input,
        readMutationOk,
        options,
      ),
    removeMembers: (ns: string, id: string, input, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/members`),
        "DELETE",
        input,
        readMutationOk,
        options,
      ),
    createArea: (ns: string, id: string, input, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/areas`),
        "POST",
        input,
        (value) => readScopeAreaResult(value, ns, id),
        options,
      ),
    updateArea: (ns: string, id: string, areaId: string, input, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/areas/${encodeURIComponent(areaId)}`),
        "PATCH",
        input,
        (value) => readScopeAreaResult(value, ns, id, areaId),
        options,
      ),
    removeArea: (ns: string, id: string, areaId: string, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/areas/${encodeURIComponent(areaId)}`),
        "DELETE",
        undefined,
        readMutationOk,
        options,
      ),
  };

  readonly warps: KozaneBackend["warps"] = {
    create: (ns: string, input, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, "/warps"),
        "POST",
        input,
        (value) => readWarpResult(value, ns),
        options,
      ),
    update: (ns: string, id: string, input, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/warps/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        (value) => readWarpResult(value, ns, id),
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      this.writeDomain(
        this.ns(ns, `/warps/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readMutationOk,
        options,
      ),
  };

  readonly inventories: KozaneBackend["inventories"] = {
    create: (ns: string, input, options?: MutationOptions) =>
      this.write<Result<typeof inventoriesServices.create>>(
        this.ns(ns, "/inventories"),
        "POST",
        input,
        options,
      ),
    update: (ns: string, id: string, input, options?: MutationOptions) =>
      this.write<Result<typeof inventoriesServices.update>>(
        this.ns(ns, `/inventories/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      this.write<Result<typeof inventoriesServices.remove>>(
        this.ns(ns, `/inventories/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        options,
      ),
    stow: (ns: string, id: string, input, options?: MutationOptions) =>
      this.write<Result<typeof inventoriesServices.stow>>(
        this.ns(ns, `/inventories/${encodeURIComponent(id)}/cards`),
        "POST",
        input,
        options,
      ),
    take: (ns: string, input, options?: MutationOptions) =>
      this.write<Result<typeof inventoriesServices.take>>(
        this.ns(ns, "/inventories/take"),
        "POST",
        input,
        options,
      ),
  };

  private readonly validators = new SnapshotValidators();
  async snapshot(
    namespaceId: string,
    options: { validator?: string } = {},
  ): Promise<SnapshotResult> {
    const generation = this.version.generation;
    const signature = this.validators.signature(namespaceId, generation, options.validator);
    const etag = signature?.startsWith("etag:") ? signature.slice(5) : undefined;
    const response = await this.transport.request(
      this.ns(namespaceId, "/snapshot"),
      "GET",
      undefined,
      {
        headers: etag ? { "if-none-match": etag } : undefined,
        allowNotModified: etag !== undefined,
        cache: "no-store",
      },
    );
    if (response.status === 304) {
      if (
        !options.validator ||
        !etag ||
        (response.headers.has("etag") && response.headers.get("etag") !== etag)
      )
        throw new BackendError("unavailable", "Invalid conditional snapshot response");
      return { status: "unchanged", validator: options.validator };
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (cause) {
      throw new BackendError("unavailable", "Invalid snapshot response", { cause });
    }
    const data = readNamespaceSnapshot(raw);
    if (!data || data.namespace.id !== namespaceId)
      throw new BackendError("unavailable", "Invalid snapshot response");
    const currentEtag = response.headers.get("etag");
    return this.validators.result(
      namespaceId,
      generation,
      currentEtag ? "etag:" + currentEtag : "data:" + JSON.stringify(data),
      data,
      options.validator,
    );
  }

  readonly tags: KozaneBackend["tags"] = {
    get: async (namespaceId?: string) => {
      const result = readTagsViewData(
        await this.read<unknown>(
          "/api/tags" +
            (namespaceId !== undefined ? "?namespaceId=" + encodeURIComponent(namespaceId) : ""),
          { cache: "no-store" },
        ),
      );
      if (!result) throw new BackendError("unavailable", "Invalid tags dataset");
      return result;
    },
  };
  readonly map: KozaneBackend["map"] = {
    get: async () => {
      const result = readMapSnapshot(await this.read<unknown>("/api/map", { cache: "no-store" }));
      if (!result) throw new BackendError("unavailable", "Invalid map dataset");
      return result;
    },
  };
  readonly warpDirectory: KozaneBackend["warpDirectory"] = {
    get: async (namespaceId: string) => {
      const result = parseWarpEntries(
        await this.read<unknown>(this.ns(namespaceId, "/warp-directory")),
      );
      if (!result) throw new BackendError("unavailable", "Invalid warp directory");
      return result;
    },
  };

  private readonly taskspaceApi: TaskspaceLifecycleApi = {
    readFile: (ns, id, path, options) =>
      this.readTaskspace(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`),
        readTaskspaceFile,
        options,
      ),
    saveFile: (ns, id, input, options) =>
      this.writeTaskspace(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/file`),
        "PUT",
        input,
        readTaskspaceFile,
        options,
      ),
    list: (ns, id, path) =>
      this.readTaskspace(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`),
        readTaskspaceListing,
      ),
    createDirectory: (ns, id, input) =>
      this.writeTaskspace(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files`),
        "POST",
        input,
        readTaskspaceListing,
      ),
    renameEntry: (ns, id, input) =>
      this.writeTaskspace(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files`),
        "PATCH",
        input,
        readTaskspaceEntryResult,
      ),
    removeEntry: (ns, id, path) =>
      this.writeTaskspace(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`),
        "DELETE",
        undefined,
        readTaskspaceEntryResult,
      ),
    create: (ns, input) =>
      this.writeTaskspace(this.ns(ns, "/taskspaces"), "POST", input, readTaskspaceCreated),
    rename: async (ns, id, input) => {
      const result = await this.writeTaskspace(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        readTaskspaceRenamed,
      );
      if (result.id !== id) throw new BackendError("unavailable", "Invalid taskspace response");
      return result;
    },
    remove: (ns, id) =>
      this.writeTaskspace(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        readTaskspaceRemoved,
      ),
    createFile: (ns, id, input) =>
      this.writeTaskspace(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/file`),
        "POST",
        input,
        readTaskspaceFile,
      ),
  };
  get taskspaces(): TaskspaceLifecycleApi | undefined {
    return this.capabilities.taskspaces ? this.taskspaceApi : undefined;
  }
}
