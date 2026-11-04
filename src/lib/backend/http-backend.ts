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
}
