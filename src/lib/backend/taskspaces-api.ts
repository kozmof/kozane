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
export interface TaskspacesApi {
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
  readFile(
    namespaceId: string,
    taskspaceId: string,
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<TaskspaceFileData>;
  saveFile(
    namespaceId: string,
    taskspaceId: string,
    input: TaskspaceFileData,
    options?: { keepalive?: boolean },
  ): Promise<TaskspaceFileData>;
  list(
    namespaceId: string,
    taskspaceId: string,
    path: string,
  ): Promise<import("../types.js").TaskspaceListing>;
  createDirectory(
    namespaceId: string,
    taskspaceId: string,
    input: { path: string },
  ): Promise<import("../types.js").TaskspaceListing>;
  renameEntry(
    namespaceId: string,
    taskspaceId: string,
    input: { path: string; name: string },
  ): Promise<{ path: string; kind: import("../types.js").TaskspaceEntryKind }>;
  removeEntry(
    namespaceId: string,
    taskspaceId: string,
    path: string,
  ): Promise<{ path: string; kind: import("../types.js").TaskspaceEntryKind }>;
}

/** Compatibility name retained for existing Node taskspace consumers. */
export type TaskspaceLifecycleApi = TaskspacesApi;
