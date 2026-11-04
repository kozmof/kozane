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
export interface MutationOptions {
  keepalive?: boolean;
}
const ALL: readonly BackendDataset[] = ["snapshot", "tags", "map", "namespaces", "warpDirectory"];

/** HTTP resource adapter. External refresh and remaining resource APIs are implemented separately. */
export class HttpBackend {
  readonly kind = "http" as const;
  readonly capabilities: BackendCapabilities;
  private readonly signals = new BackendSignals({ status: "ready" });
  private readonly transport: HttpTransport;
  constructor(
    options: HttpTransportOptions & { base?: string; capabilities: BackendCapabilities },
  ) {
    this.capabilities = Object.freeze({ ...options.capabilities });
    this.transport = new HttpTransport((path) => `${options.base ?? ""}${path}`, options);
  }
  get version() {
    return this.signals.version;
  }
  get state() {
    return this.signals.state;
  }
  subscribe: BackendSignals["subscribe"] = (listener) => this.signals.subscribe(listener);
  subscribeState: BackendSignals["subscribeState"] = (listener) =>
    this.signals.subscribeState(listener);
  private ns(namespaceId: string, path: string) {
    return `/${encodeURIComponent(namespaceId)}/api${path}`;
  }
  private async read<T>(path: string): Promise<T> {
    const response = await this.transport.request(path);
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
  readonly namespaces = {
    list: () => this.read<Result<typeof NamespaceServices.list>>("/api/namespaces"),
    get: (namespaceId: string) =>
      this.read<Result<typeof NamespaceServices.get>>(
        `/api/namespaces/${encodeURIComponent(namespaceId)}`,
      ),
    create: (input: { name: string }) =>
      this.write<Result<typeof NamespaceServices.create>>("/api/namespaces", "POST", input),
  };
  readonly cards = {
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

  readonly glues = {
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

  readonly layers = {
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

  readonly partitions = {
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

  readonly scopes = {
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

  readonly warps = {
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

  readonly inventories = {
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
}
