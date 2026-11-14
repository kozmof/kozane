import { createClientFeatures, type ClientFeatures } from "./capabilities.js";
import type {
  KozaneClient,
  ManagedClient,
  MutationOptions,
  SnapshotReadOptions,
} from "./contract.js";
import type { TaskspaceLifecycleApi } from "./contract.js";
import { WorkspacePoller, browserPollLifecycle, type PollLifecycle } from "./workspace-poller.js";
import { prepareInput } from "@kozane/core/services";
import { ValidationError } from "@kozane/core";
import { SnapshotValidators } from "./snapshot-validators.js";
import { readNamespaceSnapshot } from "./decoders/snapshot-reader.js";
import type { SnapshotResult } from "./contract.js";
import { ClientError, type ClientCapabilities, type ClientDataset } from "./contract.js";
import { ClientSignals } from "./signals.js";
import { HttpTransport, type HttpTransportOptions } from "./http-transport.js";
import type { HttpResourceContext } from "./http/context.js";
import { createNamespaces } from "./http/namespaces.js";
import { createCards } from "./http/cards.js";
import { createGlues } from "./http/glues.js";
import { createLayers } from "./http/layers.js";
import { createPartitions } from "./http/partitions.js";
import { createScopes } from "./http/scopes.js";
import { createWarps } from "./http/warps.js";
import { createInventories } from "./http/inventories.js";
import { createTags, createMap, createWarpDirectory } from "./http/datasets.js";
import { createTaskspaces } from "./http/taskspaces.js";
export type { MutationOptions } from "./contract.js";
const ALL: readonly ClientDataset[] = ["snapshot", "tags", "map", "namespaces", "warpDirectory"];
/** HTTP implementation of the shared client data and lifecycle contract. */
export class HttpClient implements ManagedClient {
  async uploadImage(file: File): Promise<{ url: string }> {
    if (this.disposed || !this.capabilities.writable) throw new ClientError("read_only", "Image uploads are unavailable");
    const form = new FormData();
    form.set("image", file);
    const response = await this.transport.request("/api/images", "POST", form, { signal: this.lifetime.signal });
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("url" in result) || typeof result.url !== "string" || !/^\/api\/images\/[a-f0-9-]{36}\.(jpg|jpeg|png|svg)$/.test(result.url)) throw new ClientError("unavailable", "Invalid image upload response");
    return { url: result.url };
  }
  private disposed = false;
  private readonly lifetime = new AbortController();
  readonly kind = "http" as const;
  private readonly features: ClientFeatures;
  get capabilities(): ClientCapabilities {
    return this.features.capabilities;
  }
  private readonly signals = new ClientSignals({ status: "ready" });
  private readonly transport: HttpTransport;
  private readonly poller?: WorkspacePoller;
  private readonly resourceContext: HttpResourceContext = {
    ns: this.ns.bind(this),
    read: this.read.bind(this),
    readTaskspace: this.readTaskspace.bind(this),
    writeTaskspace: this.writeTaskspace.bind(this),
    writeDomain: this.writeDomain.bind(this),
    capabilities: () => this.capabilities,
    disposed: () => this.disposed,
  };
  constructor(
    options: HttpTransportOptions & {
      base?: string;
      capabilities: ClientCapabilities;
      lifecycle?: PollLifecycle;
      pollingInitialDelayMs?: number;
      /** Minimum interval between filesystem-only refreshes. */
      filesystemRefreshIntervalMs?: number;
    },
  ) {
    const interval = options.filesystemRefreshIntervalMs ?? 1000;
    if (!Number.isFinite(interval) || interval < 1000)
      throw new TypeError("Filesystem refresh interval must be at least 1000ms");
    const now = options.monotonicNow ?? (() => performance.now());
    let lastRefresh = -Infinity;
    this.features = createClientFeatures(
      options.capabilities,
      options.capabilities.taskspaces ? this.taskspaceApi : undefined,
    );
    this.transport = new HttpTransport((path) => `${options.base ?? ""}${path}`, options);
    if (this.capabilities.externalWrites)
      this.poller = new WorkspacePoller({
        lifecycle: options.lifecycle ?? browserPollLifecycle(),
        initialDelayMs: options.pollingInitialDelayMs,
        throttleMs: () => this.transport.retryAfterMs,
        token: async () => {
          const value = await this.read("/api/changes");
          if (
            value === null ||
            typeof value !== "object" ||
            !("token" in value) ||
            typeof value.token !== "string" ||
            !value.token
          )
            throw new ClientError("unavailable", "Invalid change token");
          return value.token;
        },
        changed: () => this.invalidateAll(),
        failed: (cause) =>
          this.signals.transition({
            status: "ready",
            refreshError:
              cause instanceof ClientError
                ? cause
                : new ClientError("unavailable", "Could not check workspace changes"),
          }),
        succeeded: () => {
          if (this.state.status === "ready" && this.state.refreshError)
            this.signals.transition({ status: "ready" });
        },
        filesystemRefresh: () => {
          if (this.capabilities.taskspaces && now() - lastRefresh >= interval) {
            lastRefresh = now();
            this.signals.publish(["tags", "snapshot"]);
          }
        },
      });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.poller?.dispose();
    const error = new ClientError("unavailable", "Client is disposed");
    this.lifetime.abort(error);
    this.validators.clear();
    this.signals.transition({ status: "unavailable", error, recovery: "reload" });
    this.signals.dispose();
  }
  private assertActive(): void {
    this.lifetime.signal.throwIfAborted();
  }
  private readSignal(signal?: AbortSignal): AbortSignal {
    this.assertActive();
    return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
  }
  get version() {
    return this.signals.version;
  }
  get state() {
    return this.signals.state;
  }
  subscribe: ClientSignals["subscribe"] = (listener) => {
    if (this.disposed) return () => {};
    const unsubscribe = this.signals.subscribe(listener);
    const release = this.poller?.retain();
    return () => {
      unsubscribe();
      release?.();
    };
  };
  subscribeState: ClientSignals["subscribeState"] = (listener) =>
    this.signals.subscribeState(listener);
  private ns(namespaceId: string, path: string) {
    return `/${encodeURIComponent(namespaceId)}/api${path}`;
  }
  private async read(
    path: string,
    options?: {
      signal?: AbortSignal;
      cache?: RequestInit["cache"];
    },
  ): Promise<unknown> {
    const signal = this.readSignal(options?.signal);
    signal.throwIfAborted();
    const response = await this.transport.request(path, "GET", undefined, { ...options, signal });
    try {
      const result: unknown = await response.json();
      signal.throwIfAborted();
      return result;
    } catch (cause) {
      signal.throwIfAborted();
      throw new ClientError("unavailable", "Invalid client response", { cause });
    }
  }
  private async write<T>(
    path: string,
    method: string,
    input?: unknown,
    options?: MutationOptions,
  ): Promise<T> {
    this.assertActive();
    if (!this.capabilities.writable) throw new ClientError("read_only", "This client is read-only");
    const response = await this.transport.request(path, method, input, {
      keepalive: options?.keepalive,
    });
    // The HTTP mutation committed even if its response body cannot be decoded.
    this.invalidateAll();
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new ClientError("unavailable", "Invalid client response", { cause });
    }
  }
  private invalidateAll(): void {
    // Conservative tokens and committed writes must force a server read, rather
    // than reuse a metadata-only conditional-response cache entry.
    if (this.disposed) return;
    this.validators.clear();
    this.signals.publish(ALL);
  }
  private checked<T>(
    value: unknown,
    decode: (value: unknown) => T | null,
    message = "Invalid taskspace response",
  ): T {
    const result = decode(value);
    if (result === null) throw new ClientError("unavailable", message);
    return result;
  }
  private async readTaskspace<T>(
    path: string,
    decode: (value: unknown) => T | null,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<T> {
    return this.checked(await this.read(path, options), decode);
  }
  private async writeTaskspace<T>(
    path: string,
    method: string,
    input: unknown,
    decode: (value: unknown) => T | null,
    options?: MutationOptions,
  ): Promise<T> {
    // Preserve committed invalidation even when a successful response has malformed fields.
    return this.checked(
      await this.write<unknown>(path, method, this.prepareMutation(input), options),
      decode,
    );
  }
  /** Copy once at the client boundary, before encoding or checking response semantics. */
  private prepareMutation<Input>(input: Input): Input {
    this.assertActive();
    if (!this.capabilities.writable) throw new ClientError("read_only", "This client is read-only");
    if (input === undefined) return input;
    try {
      return prepareInput(input);
    } catch (error) {
      if (error instanceof ValidationError) throw new ClientError("validation", error.message);
      throw error;
    }
  }
  private async writeDomain<T, Input>(
    path: string,
    method: string,
    input: Input,
    decode: (value: unknown, input: Input) => T | null,
    options?: MutationOptions,
  ): Promise<T> {
    const prepared = this.prepareMutation(input);
    return this.checked(
      await this.write<unknown>(path, method, prepared, options),
      (value) => decode(value, prepared),
      "Invalid mutation response",
    );
  }
  readonly namespaces: KozaneClient["namespaces"] = createNamespaces(this.resourceContext);
  readonly cards: KozaneClient["cards"] = createCards(this.resourceContext);
  readonly glues: KozaneClient["glues"] = createGlues(this.resourceContext);
  readonly layers: KozaneClient["layers"] = createLayers(this.resourceContext);
  readonly partitions: KozaneClient["partitions"] = createPartitions(this.resourceContext);
  readonly scopes: KozaneClient["scopes"] = createScopes(this.resourceContext);
  readonly warps: KozaneClient["warps"] = createWarps(this.resourceContext);
  readonly inventories: KozaneClient["inventories"] = createInventories(this.resourceContext);
  private readonly validators = new SnapshotValidators();
  async snapshot(namespaceId: string, options: SnapshotReadOptions = {}): Promise<SnapshotResult> {
    const signal = this.readSignal(options.signal);
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
        signal,
      },
    );
    signal.throwIfAborted();
    if (response.status === 304) {
      if (
        !options.validator ||
        !etag ||
        (response.headers.has("etag") && response.headers.get("etag") !== etag)
      )
        throw new ClientError("unavailable", "Invalid conditional snapshot response");
      return { status: "unchanged", validator: options.validator };
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (cause) {
      signal.throwIfAborted();
      throw new ClientError("unavailable", "Invalid snapshot response", { cause });
    }
    signal.throwIfAborted();
    const data = readNamespaceSnapshot(raw);
    if (!data || data.namespace.id !== namespaceId)
      throw new ClientError("unavailable", "Invalid snapshot response");
    const currentEtag = response.headers.get("etag");
    return this.validators.result(
      namespaceId,
      generation,
      currentEtag ? "etag:" + currentEtag : "data:" + JSON.stringify(data),
      data,
      options.validator,
    );
  }
  readonly tags: KozaneClient["tags"] = createTags(this.resourceContext);
  readonly map: KozaneClient["map"] = createMap(this.resourceContext);
  readonly warpDirectory: KozaneClient["warpDirectory"] = createWarpDirectory(this.resourceContext);
  private readonly taskspaceApi: TaskspaceLifecycleApi = createTaskspaces(this.resourceContext);
  get taskspaces(): TaskspaceLifecycleApi | undefined {
    return this.features.taskspaces;
  }
}
