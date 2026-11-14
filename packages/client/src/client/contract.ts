import type {
  CardsApi,
  GluesApi,
  LayersApi,
  PartitionsApi,
  ScopesApi,
  WarpsApi,
  InventoriesApi,
  NamespacesApi,
  TagsApi,
  MapApi,
  WarpDirectoryApi,
  TaskspacesApi,
} from "./resources.js";
export * from "./resources.js";
import type { ReadOptions } from "./resources.js";
import type { NamespaceDataSnapshot } from "@kozane/core";
export type ClientErrorCode =
  | "validation"
  | "not_found"
  | "conflict"
  | "limit"
  | "read_only"
  | "unauthenticated"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "network";
export class ClientError extends Error {
  override readonly name = "ClientError";
  readonly retryAfterMs?: number;
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    options: ErrorOptions & { retryAfterMs?: number } = {},
  ) {
    super(message, options);
    this.retryAfterMs = options.retryAfterMs;
    Object.freeze(this);
  }
}
export interface ClientCapabilities {
  readonly writable: boolean;
  readonly taskspaces: boolean;
  readonly auth: boolean;
  readonly persistent: boolean;
  readonly externalWrites: boolean;
}
export type ClientState =
  | { readonly status: "initializing" | "recovering" }
  | {
      readonly status: "ready";
      /** A retryable external-refresh failure. Data and write readiness remain intact. */
      readonly refreshError?: ClientError;
    }
  | {
      readonly status: "unavailable";
      readonly error: ClientError;
      readonly recovery: "retry" | "reload";
    };
export interface ClientVersion {
  readonly generation: number;
  readonly revision: number;
}
export type ClientDataset = "snapshot" | "tags" | "map" | "namespaces" | "warpDirectory";
export interface ClientInvalidation extends ClientVersion {
  readonly datasets: readonly ClientDataset[];
  readonly namespaceIds?: readonly string[];
}
export type SnapshotData = NamespaceDataSnapshot;
export type SnapshotResult =
  | { status: "changed"; validator: string; data: SnapshotData }
  | { status: "unchanged"; validator: string };

export interface SnapshotReadOptions extends ReadOptions {
  validator?: string;
}
/** Shared data and lifecycle surface implemented by every deployment adapter.
 * See operation-matrix.md for behavior and verification coverage.
 */
export interface KozaneClient {
  uploadImage?: (file: File) => Promise<{ url: string }>;
  readonly kind: "http" | "static" | "local";
  readonly capabilities: ClientCapabilities;
  readonly version: ClientVersion;
  readonly state: ClientState;
  subscribe(listener: (event: ClientInvalidation) => void): () => void;
  subscribeState(listener: (state: ClientState) => void): () => void;
  snapshot(namespaceId: string, options?: SnapshotReadOptions): Promise<SnapshotResult>;
  readonly namespaces: NamespacesApi;
  readonly cards: CardsApi;
  readonly glues: GluesApi;
  readonly layers: LayersApi;
  readonly partitions: PartitionsApi;
  readonly scopes: ScopesApi;
  readonly warps: WarpsApi;
  readonly inventories: InventoriesApi;
  readonly tags: TagsApi;
  readonly map: MapApi;
  readonly warpDirectory: WarpDirectoryApi;
  readonly taskspaces?: TaskspacesApi;
}

/** Owned by a host session. Views borrow the client and never dispose it. */
export interface ManagedClient extends KozaneClient {
  /** Synchronous and idempotent. Never implies rollback of a dispatched mutation. */
  dispose(): void;
}
