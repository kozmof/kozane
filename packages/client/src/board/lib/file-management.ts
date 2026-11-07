import type {
  Scope,
  TaskspaceDirectoryOutcome,
  TaskspaceEntryKind,
  TaskspaceSummary,
} from "@kozane/core";
import type { OpenFileRef } from "../../editor/index.js";

/**
 * Rules for renaming and deleting scopes, taskspaces, files, and folders in the file browser:
 * what blocks a change, and what each confirmation says.
 */

/** What the file browser changes, supplied by the board's actions. */
export type FileManagementActions = {
  createScope: (name: string) => Promise<{ id: string } | { error: string }>;
  renameScope: (scopeId: string, name: string) => Promise<{ error: string } | null>;
  removeScope: (scopeId: string) => Promise<{ error: string } | null>;
  createTaskspace: (scopeId: string, name: string) => Promise<{ id: string } | { error: string }>;
  renameTaskspace: (taskspaceId: string, name: string) => Promise<{ error: string } | null>;
  /** `directory` is null when the server's answer did not say what happened to it. */
  deleteTaskspace: (
    taskspaceId: string,
  ) => Promise<{ directory: TaskspaceDirectoryOutcome | null } | { error: string }>;
};

/**
 * Why the file open in the editor prevents changing `path` in `taskspaceId`, or null. With no
 * path, the question is about the whole taskspace.
 */
export function blockedByEditor(
  editorFile: OpenFileRef | null,
  taskspaceId: string,
  path?: string,
): string | null {
  if (!editorFile || editorFile.taskspaceId !== taskspaceId) return null;
  if (path !== undefined && editorFile.path !== path && !editorFile.path.startsWith(`${path}/`))
    return null;
  return `Close ${editorFile.path} in the editor first.`;
}

/**
 * Why a scope cannot be deleted from this board, or null. A scope with taskspaces would come
 * straight back, because its taskspaces keep it on the board.
 */
export function scopeDeleteBlock(taskspaces: TaskspaceSummary[], scopeId: string): string | null {
  return taskspaces.some((t) => t.scopeId === scopeId) ? "Delete its taskspaces first" : null;
}

export function confirmRemoveScope(scope: Scope): boolean {
  return globalThis.confirm(
    `Delete scope "${scope.name}" from this board?\n\nCards stay on the board and leave the scope. Its frames on this board are removed.`,
  );
}

export function confirmDeleteTaskspace(taskspace: TaskspaceSummary): boolean {
  const disk =
    taskspace.path === null
      ? "It has no directory."
      : taskspace.pathKind === "absolute"
        ? `Its directory ${taskspace.path} stays on disk.`
        : // Only the server can tell whether Kozane created the directory, so say both cases.
          `If Kozane created its directory ${taskspace.path}, that directory and everything in it will be deleted from disk. This cannot be undone.\nA directory you chose yourself stays on disk.`;
  return globalThis.confirm(`Delete taskspace "${taskspace.name}"?\n\n${disk}`);
}

export function confirmDeleteEntry(path: string, kind: TaskspaceEntryKind): boolean {
  const what =
    kind === "directory" ? `Delete folder "${path}" and everything in it?` : `Delete "${path}"?`;
  return globalThis.confirm(`${what}\n\nThis cannot be undone.`);
}

/**
 * What to tell the user after a taskspace delete kept a directory the confirmation said might
 * go, or null when nothing needs saying.
 */
export function keptDirectoryNotice(
  taskspace: TaskspaceSummary,
  directory: TaskspaceDirectoryOutcome | null,
): string | null {
  if (directory !== "kept" || taskspace.path === null || taskspace.pathKind === "absolute")
    return null;
  return `Taskspace deleted. ${taskspace.path} was kept because it is not marked as made by Kozane.`;
}

/** A failure or a notice from one of the steps above, for the view to show. */
export type ManagementMessage = { kind: "error" | "notice"; text: string };

/**
 * Remove a scope from the board after the checks and the confirmation. Answer what to show,
 * or null when there is nothing to say (done, or declined).
 */
export async function removeScopeFlow(
  actions: FileManagementActions,
  taskspaces: TaskspaceSummary[],
  scope: Scope,
): Promise<ManagementMessage | null> {
  const blocked = scopeDeleteBlock(taskspaces, scope.id);
  if (blocked) return { kind: "error", text: blocked };
  if (!confirmRemoveScope(scope)) return null;
  const failed = await actions.removeScope(scope.id);
  return failed ? { kind: "error", text: failed.error } : null;
}

/** Delete a taskspace after the checks and the confirmation. See {@link removeScopeFlow}. */
export async function deleteTaskspaceFlow(
  actions: FileManagementActions,
  editorFile: OpenFileRef | null,
  taskspace: TaskspaceSummary,
): Promise<ManagementMessage | null> {
  const blocked = blockedByEditor(editorFile, taskspace.id);
  if (blocked) return { kind: "error", text: blocked };
  if (!confirmDeleteTaskspace(taskspace)) return null;
  const result = await actions.deleteTaskspace(taskspace.id);
  if ("error" in result) return { kind: "error", text: result.error };
  const notice = keptDirectoryNotice(taskspace, result.directory);
  return notice ? { kind: "notice", text: notice } : null;
}

/** Delete a file or folder after the checks and the confirmation. See {@link removeScopeFlow}. */
export async function deleteEntryFlow(
  remove: (taskspaceId: string, path: string) => Promise<{ error: string } | null>,
  editorFile: OpenFileRef | null,
  taskspaceId: string,
  path: string,
  kind: TaskspaceEntryKind,
): Promise<ManagementMessage | null> {
  const blocked = blockedByEditor(editorFile, taskspaceId, path);
  if (blocked) return { kind: "error", text: blocked };
  if (!confirmDeleteEntry(path, kind)) return null;
  const failed = await remove(taskspaceId, path);
  return failed ? { kind: "error", text: failed.error } : null;
}
