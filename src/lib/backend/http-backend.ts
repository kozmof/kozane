import type { KozaneBackend, MutationOptions } from "./contract.js";
export type { MutationOptions } from "./contract.js";
import type {
  TaskspaceLifecycleApi,
  TaskspaceCreated,
  TaskspaceRenamed,
  TaskspaceFileData,
} from "./contract.js";
import { WorkspacePoller, browserPollLifecycle, type PollLifecycle } from "./workspace-poller.js";
import { readTagsViewData } from "./decoders/tags.js";
import { readMapSnapshot } from "./decoders/map.js";
import type { WarpListEntry } from "../warp-list.js";
import type * as inventoriesServices from "../../services/inventories.js";
import type * as warpsServices from "../../services/warps.js";
import type * as scopesServices from "../../services/scopes.js";
import type * as partitionsServices from "../../services/partitions.js";
import type * as layersServices from "../../services/layers.js";
import type * as gluesServices from "../../services/glues.js";
import { SnapshotValidators } from "./snapshot-validators.js";
import { readNamespaceSnapshot } from "./decoders/snapshot-reader.js";
import type { SnapshotResult } from "./contract.js";
import type * as CardServices from "../../services/cards.js";
import type * as NamespaceServices from "../../services/namespaces.js";
import { BackendError, type BackendCapabilities, type BackendDataset } from "./contract.js";
import { BackendSignals } from "./signals.js";
import { HttpTransport, type HttpTransportOptions } from "./http-transport.js";

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
const ALL: readonly BackendDataset[] = ["snapshot", "tags", "map", "namespaces", "warpDirectory"];

/** HTTP resource adapter. External refresh and remaining resource APIs are implemented separately. */
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
  readonly namespaces: KozaneBackend["namespaces"] = {
    list: () => this.read<Result<typeof NamespaceServices.list>>("/api/namespaces"),
    get: (namespaceId: string) =>
      this.read<Result<typeof NamespaceServices.get>>(
        `/api/namespaces/${encodeURIComponent(namespaceId)}`,
      ),
    create: (input: { name: string }) =>
      this.write<Result<typeof NamespaceServices.create>>("/api/namespaces", "POST", input),
  };
  readonly cards: KozaneBackend["cards"] = {
    create: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof CardServices.create>>(this.ns(ns, "/cards"), "POST", input, options),
    update: (ns: string, id: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof CardServices.update>>(
        this.ns(ns, `/cards/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        options,
      ),
    updatePositions: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof CardServices.updatePositions>>(
        this.ns(ns, "/cards"),
        "PATCH",
        input,
        options,
      ),
    remove: (ns: string, input: Record<string, unknown>) =>
      this.write<Result<typeof CardServices.remove>>(this.ns(ns, "/cards"), "DELETE", input),
    removeOne: (ns: string, id: string) =>
      this.write<Result<typeof CardServices.removeOne>>(
        this.ns(ns, `/cards/${encodeURIComponent(id)}`),
        "DELETE",
      ),
    move: (ns: string, input: Record<string, unknown>) =>
      this.write<Result<typeof CardServices.move>>(this.ns(ns, "/cards/move"), "POST", input),
    setLayer: (ns: string, input: Record<string, unknown>) =>
      this.write<Result<typeof CardServices.setLayer>>(this.ns(ns, "/cards/layer"), "PATCH", input),
    setPartition: (ns: string, input: Record<string, unknown>) =>
      this.write<Result<typeof CardServices.setPartition>>(
        this.ns(ns, "/cards/partition"),
        "PATCH",
        input,
      ),
    setStacking: (ns: string, input: Record<string, unknown>) =>
      this.write<Result<typeof CardServices.setStacking>>(
        this.ns(ns, "/cards/stacking"),
        "PATCH",
        input,
      ),
    squash: (ns: string, input: Record<string, unknown>) =>
      this.write<Result<typeof CardServices.squash>>(this.ns(ns, "/cards/squash"), "POST", input),
  };

  readonly glues: KozaneBackend["glues"] = {
    create: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof gluesServices.create>>(
        this.ns(ns, "/glues"),
        "POST",
        input,
        options,
      ),
    remove: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof gluesServices.remove>>(
        this.ns(ns, "/glues"),
        "DELETE",
        input,
        options,
      ),
  };

  readonly layers: KozaneBackend["layers"] = {
    create: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof layersServices.create>>(
        this.ns(ns, "/layers"),
        "POST",
        input,
        options,
      ),
    rename: (ns: string, id: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof layersServices.rename>>(
        this.ns(ns, `/layers/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      this.write<Result<typeof layersServices.remove>>(
        this.ns(ns, `/layers/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        options,
      ),
    reorder: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof layersServices.reorder>>(
        this.ns(ns, "/layers"),
        "PATCH",
        input,
        options,
      ),
  };

  readonly partitions: KozaneBackend["partitions"] = {
    create: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof partitionsServices.create>>(
        this.ns(ns, "/partitions"),
        "POST",
        input,
        options,
      ),
    rename: (ns: string, id: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof partitionsServices.rename>>(
        this.ns(ns, `/partitions/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      this.write<Result<typeof partitionsServices.remove>>(
        this.ns(ns, `/partitions/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        options,
      ),
  };

  readonly scopes: KozaneBackend["scopes"] = {
    create: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof scopesServices.create>>(
        this.ns(ns, "/scopes"),
        "POST",
        input,
        options,
      ),
    rename: (ns: string, id: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof scopesServices.rename>>(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      this.write<Result<typeof scopesServices.remove>>(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        options,
      ),
    addMembers: (
      ns: string,
      id: string,
      input: Record<string, unknown>,
      options?: MutationOptions,
    ) =>
      this.write<Result<typeof scopesServices.addMembers>>(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/members`),
        "POST",
        input,
        options,
      ),
    removeMembers: (
      ns: string,
      id: string,
      input: Record<string, unknown>,
      options?: MutationOptions,
    ) =>
      this.write<Result<typeof scopesServices.removeMembers>>(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/members`),
        "DELETE",
        input,
        options,
      ),
    createArea: (
      ns: string,
      id: string,
      input: Record<string, unknown>,
      options?: MutationOptions,
    ) =>
      this.write<Result<typeof scopesServices.createArea>>(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/areas`),
        "POST",
        input,
        options,
      ),
    updateArea: (
      ns: string,
      id: string,
      areaId: string,
      input: Record<string, unknown>,
      options?: MutationOptions,
    ) =>
      this.write<Result<typeof scopesServices.updateArea>>(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/areas/${encodeURIComponent(areaId)}`),
        "PATCH",
        input,
        options,
      ),
    removeArea: (ns: string, id: string, areaId: string, options?: MutationOptions) =>
      this.write<Result<typeof scopesServices.removeArea>>(
        this.ns(ns, `/scopes/${encodeURIComponent(id)}/areas/${encodeURIComponent(areaId)}`),
        "DELETE",
        undefined,
        options,
      ),
  };

  readonly warps: KozaneBackend["warps"] = {
    create: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof warpsServices.create>>(
        this.ns(ns, "/warps"),
        "POST",
        input,
        options,
      ),
    update: (ns: string, id: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof warpsServices.update>>(
        this.ns(ns, `/warps/${encodeURIComponent(id)}`),
        "PATCH",
        input,
        options,
      ),
    remove: (ns: string, id: string, options?: MutationOptions) =>
      this.write<Result<typeof warpsServices.remove>>(
        this.ns(ns, `/warps/${encodeURIComponent(id)}`),
        "DELETE",
        undefined,
        options,
      ),
  };

  readonly inventories: KozaneBackend["inventories"] = {
    create: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof inventoriesServices.create>>(
        this.ns(ns, "/inventories"),
        "POST",
        input,
        options,
      ),
    update: (ns: string, id: string, input: Record<string, unknown>, options?: MutationOptions) =>
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
    stow: (ns: string, id: string, input: Record<string, unknown>, options?: MutationOptions) =>
      this.write<Result<typeof inventoriesServices.stow>>(
        this.ns(ns, `/inventories/${encodeURIComponent(id)}/cards`),
        "POST",
        input,
        options,
      ),
    take: (ns: string, input: Record<string, unknown>, options?: MutationOptions) =>
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
    get: (namespaceId: string) =>
      this.read<WarpListEntry[]>(this.ns(namespaceId, "/warp-directory")),
  };

  private readonly taskspaceApi: TaskspaceLifecycleApi = {
    readFile: (ns, id, path, options) =>
      this.read<TaskspaceFileData>(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`),
        options,
      ),
    saveFile: (ns, id, input, options) =>
      this.write<TaskspaceFileData>(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/file`),
        "PUT",
        input,
        options,
      ),
    list: (ns, id, path) =>
      this.read<import("../types.js").TaskspaceListing>(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`),
      ),
    createDirectory: (ns, id, input) =>
      this.write<import("../types.js").TaskspaceListing>(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files`),
        "POST",
        input,
      ),
    renameEntry: (ns, id, input) =>
      this.write<{ path: string; kind: import("../types.js").TaskspaceEntryKind }>(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files`),
        "PATCH",
        input,
      ),
    removeEntry: (ns, id, path) =>
      this.write<{ path: string; kind: import("../types.js").TaskspaceEntryKind }>(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`),
        "DELETE",
      ),
    create: (ns, input) => this.write<TaskspaceCreated>(this.ns(ns, "/taskspaces"), "POST", input),
    rename: (ns, id, input) =>
      this.write<TaskspaceRenamed>(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}`),
        "PATCH",
        input,
      ),
    remove: (ns, id) =>
      this.write<{ ok: boolean; directory: import("../types.js").TaskspaceDirectoryOutcome }>(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}`),
        "DELETE",
      ),
    createFile: (ns, id, input) =>
      this.write<TaskspaceFileData>(
        this.ns(ns, `/taskspaces/${encodeURIComponent(id)}/file`),
        "POST",
        input,
      ),
  };
  get taskspaces(): TaskspaceLifecycleApi | undefined {
    return this.capabilities.taskspaces ? this.taskspaceApi : undefined;
  }
}
