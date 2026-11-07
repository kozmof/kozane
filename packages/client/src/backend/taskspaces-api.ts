import type { PathKind } from "../constants/index.js";
import type {
  TaskspaceDirectoryOutcome,
  TaskspaceEntryKind,
  TaskspaceListing,
  TaskspaceSummary,
} from "@kozane/core";
import type { MutationOptions } from "./resources.js";

export interface TaskspaceCreated {
  id: string;
  path: string;
  pathKind: PathKind;
}
export interface TaskspaceRenamed {
  id: string;
  name: string;
  path: string | null;
  pathKind: PathKind;
}
export interface TaskspaceFileData {
  path: string;
  content: string;
  signature: string | null;
}
export type TaskspaceCreateInput = { name: string; scopeId: string };
export type TaskspaceCreateResult = TaskspaceCreated;
export type TaskspaceRenameInput = { name: string };
export type TaskspaceRenameResult = TaskspaceRenamed;
export type TaskspaceRemoveResult = { ok: boolean; directory: TaskspaceDirectoryOutcome };
export type TaskspaceCreateFileInput = { path: string };
export type TaskspaceCreateFileResult = TaskspaceFileData;
export type TaskspaceReadFileResult = TaskspaceFileData;
export interface TaskspaceReadFileOptions {
  signal?: AbortSignal;
}
/** The last-read signature is required, including null. A mismatch rejects the save. */
export type TaskspaceSaveFileInput = TaskspaceFileData;
export type TaskspaceSaveFileResult = TaskspaceFileData;
export type TaskspaceListResult = TaskspaceListing;
export type TaskspaceCreateDirectoryInput = { path: string };
export type TaskspaceCreateDirectoryResult = TaskspaceListing;
export type TaskspaceRenameEntryInput = { path: string; name: string };
export type TaskspaceRenameEntryResult = { path: string; kind: TaskspaceEntryKind };
export type TaskspaceRemoveEntryResult = TaskspaceRenameEntryResult;

export interface TaskspaceAccess {
  readonly browse: boolean;
  readonly read: boolean;
  readonly write: boolean;
  readonly refresh: boolean;
}

/** Filesystem operations require taskspaces capability. Static exports provide embedded reads only. */
export interface TaskspacesApi {
  /** Synchronous availability from current metadata. Performs no I/O. */
  access(namespaceId: string, taskspace: Pick<TaskspaceSummary, "id" | "path">): TaskspaceAccess;
  create(namespaceId: string, input: TaskspaceCreateInput): Promise<TaskspaceCreateResult>;
  rename(
    namespaceId: string,
    taskspaceId: string,
    input: TaskspaceRenameInput,
  ): Promise<TaskspaceRenameResult>;
  remove(namespaceId: string, taskspaceId: string): Promise<TaskspaceRemoveResult>;
  createFile(
    namespaceId: string,
    taskspaceId: string,
    input: TaskspaceCreateFileInput,
  ): Promise<TaskspaceCreateFileResult>;
  readFile(
    namespaceId: string,
    taskspaceId: string,
    path: string,
    options?: TaskspaceReadFileOptions,
  ): Promise<TaskspaceReadFileResult>;
  saveFile(
    namespaceId: string,
    taskspaceId: string,
    input: TaskspaceSaveFileInput,
    options?: MutationOptions,
  ): Promise<TaskspaceSaveFileResult>;
  list(namespaceId: string, taskspaceId: string, path: string): Promise<TaskspaceListResult>;
  createDirectory(
    namespaceId: string,
    taskspaceId: string,
    input: TaskspaceCreateDirectoryInput,
  ): Promise<TaskspaceCreateDirectoryResult>;
  renameEntry(
    namespaceId: string,
    taskspaceId: string,
    input: TaskspaceRenameEntryInput,
  ): Promise<TaskspaceRenameEntryResult>;
  removeEntry(
    namespaceId: string,
    taskspaceId: string,
    path: string,
  ): Promise<TaskspaceRemoveEntryResult>;
}

/** Compatibility name retained for existing Node taskspace consumers. */
export type TaskspaceLifecycleApi = TaskspacesApi;
