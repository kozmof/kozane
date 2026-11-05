import type { NamespaceDataSnapshot } from "../types.js";
export type BackendErrorCode =
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
export class BackendError extends Error {
  override readonly name = "BackendError";
  readonly retryAfterMs?: number;
  constructor(
    readonly code: BackendErrorCode,
    message: string,
    options: ErrorOptions & { retryAfterMs?: number } = {},
  ) {
    super(message, options);
    this.retryAfterMs = options.retryAfterMs;
    Object.freeze(this);
  }
}
export interface BackendCapabilities {
  readonly writable: boolean;
  readonly taskspaces: boolean;
  readonly auth: boolean;
  readonly persistent: boolean;
  readonly externalWrites: boolean;
}
export type BackendState =
  | { readonly status: "initializing" | "ready" | "recovering" }
  | {
      readonly status: "unavailable";
      readonly error: BackendError;
      readonly recovery: "retry" | "reload";
    };
export interface BackendVersion {
  readonly generation: number;
  readonly revision: number;
}
export type BackendDataset = "snapshot" | "tags" | "map" | "namespaces" | "warpDirectory";
export interface BackendInvalidation extends BackendVersion {
  readonly datasets: readonly BackendDataset[];
  readonly namespaceIds?: readonly string[];
}
export type SnapshotData = NamespaceDataSnapshot;
export type SnapshotResult =
  | { status: "changed"; validator: string; data: SnapshotData }
  | { status: "unchanged"; validator: string };

export interface TaskspaceCreated {
  id: string;
  path: string;
  pathKind: import("../constants.js").PathKind;
}
export interface TaskspaceRenamed {
  id: string;
  name: string;
  path: string | null;
  pathKind: import("../constants.js").PathKind;
}
export interface TaskspaceFileData {
  path: string;
  content: string;
  signature: string | null;
}
export interface TaskspaceLifecycleApi {
  create(namespaceId: string, input: { name: string; scopeId: string }): Promise<TaskspaceCreated>;
  rename(
    namespaceId: string,
    taskspaceId: string,
    input: { name: string },
  ): Promise<TaskspaceRenamed>;
  remove(
    namespaceId: string,
    taskspaceId: string,
  ): Promise<{ ok: boolean; directory: import("../types.js").TaskspaceDirectoryOutcome }>;
  createFile(
    namespaceId: string,
    taskspaceId: string,
    input: { path: string },
  ): Promise<TaskspaceFileData>;
}
