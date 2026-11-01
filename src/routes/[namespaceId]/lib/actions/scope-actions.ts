import * as api from "../namespace-api.js";
import type { NamespaceState } from "../../namespace-state.svelte.js";
import type { BoardRect } from "$lib/constants";
import { readString } from "../response.js";

/** Scope, scope frame, membership, and taskspace actions. */
export function createScopeActions(state: NamespaceState) {
  /**
   * Create a taskspace directory in a scope and add it to the board. Return the server's
   * reason on failure so callers with their own name field, such as scope frames, can show it
   * there instead of in the banner.
   */
  async function createTaskspace(
    scopeId: string,
    rawName: string,
  ): Promise<{ id: string } | { error: string }> {
    const name = rawName.trim();
    if (!name) return { error: "Taskspace name is required" };
    const res = await api.createTaskspace(state.mutationFetcher, state.namespaceId, {
      name,
      scopeId,
    });
    if (!res.ok) return { error: await api.failureMessage(res, "Failed to create taskspace") };
    const parsed = await res.json().catch(() => null);
    const id = readString(parsed, "id");
    if (id === undefined) return { error: "Failed to create taskspace" };
    state.taskspaces = [
      ...state.taskspaces,
      { id, name, scopeId, path: parsed.path, pathKind: parsed.pathKind },
    ];
    return { id };
  }

  /**
   * Add selected cards to a scope without clearing the selection used by the file palette.
   * Return whether linking succeeded.
   */
  async function handleLinkScope(scopeId: string): Promise<boolean> {
    if (state.selection.selectedCards.size === 0) return false;
    const cardIds = [...state.selection.selectedCards];
    const res = await api.addCardsToScope(
      state.mutationFetcher,
      state.namespaceId,
      scopeId,
      cardIds,
    );
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to link cards to scope"));
      return false;
    }
    state.scopeRels = [
      ...state.scopeRels,
      ...cardIds
        .filter((cid) => !state.scopeRels.some((r) => r.scopeId === scopeId && r.cardId === cid))
        .map((cardId) => ({ scopeId, cardId })),
    ];
    return true;
  }

  /**
   * Create a scope, taskspace, and empty file, then link selected cards. Preserve server
   * error messages for each step.
   *
   * If taskspace creation fails, remove the newly created scope. After that step, retain
   * created resources so the user can finish through existing controls. Return the file to
   * open, or null.
   */
  async function handleCreateScopeWithFile(names: {
    scope: string;
    taskspace: string;
    file: string;
  }): Promise<{ taskspaceId: string; taskspaceName: string; path: string } | null> {
    const scopeName = names.scope.trim();
    const taskspaceName = names.taskspace.trim();
    const fileName = names.file.trim();
    if (!scopeName || !taskspaceName || !fileName) {
      state.setError("A scope, taskspace, and file name are all required");
      return null;
    }

    const scopeRes = await api.createScope(state.mutationFetcher, state.namespaceId, scopeName);
    const scope = scopeRes.ok ? await scopeRes.json().catch(() => null) : null;
    const scopeId = readString(scope, "id");
    if (scopeId === undefined) {
      state.setError(await api.failureMessage(scopeRes, "Failed to create scope"));
      return null;
    }
    state.scopes = [...state.scopes, { id: scopeId, name: scopeName }];

    const taskspaceRes = await api.createTaskspace(state.mutationFetcher, state.namespaceId, {
      name: taskspaceName,
      scopeId,
    });
    const taskspace = taskspaceRes.ok ? await taskspaceRes.json().catch(() => null) : null;
    const taskspaceId = readString(taskspace, "id");
    if (taskspaceId === undefined) {
      const message = await api.failureMessage(taskspaceRes, "Failed to create taskspace");
      // Remove the scope created for this failed taskspace. If cleanup also fails, leave it
      // available for deletion in the sidebar.
      await api.deleteScope(state.mutationFetcher, state.namespaceId, scopeId);
      state.scopes = state.scopes.filter((existing) => existing.id !== scopeId);
      state.setError(message);
      return null;
    }
    state.taskspaces = [
      ...state.taskspaces,
      {
        id: taskspaceId,
        name: taskspaceName,
        scopeId,
        path: taskspace.path,
        pathKind: taskspace.pathKind,
      },
    ];

    const fileRes = await api.createTaskspaceFile(
      state.mutationFetcher,
      state.namespaceId,
      taskspaceId,
      fileName,
    );
    const file = fileRes.ok ? await fileRes.json().catch(() => null) : null;
    if (typeof file?.path !== "string") {
      state.setError(await api.failureMessage(fileRes, "Failed to create file"));
      return null;
    }

    // Link membership last to avoid undoing it if creation fails. Report link failures but
    // still open the created file.
    await handleLinkScope(scopeId);

    return { taskspaceId, taskspaceName, path: file.path };
  }

  /**
   * Apply membership changes for cards crossing frame boundaries. Handle entry and exit
   * requests independently, rolling back only the failed half. Preserve the current
   * selection.
   */
  async function handleScopeMembershipChange(
    scopeId: string,
    { entered, exited }: { entered: string[]; exited: string[] },
  ) {
    if (entered.length > 0) {
      const added = entered.filter(
        (cid) => !state.scopeRels.some((r) => r.scopeId === scopeId && r.cardId === cid),
      );
      state.scopeRels = [...state.scopeRels, ...added.map((cardId) => ({ scopeId, cardId }))];
      const res = await api.addCardsToScope(
        state.mutationFetcher,
        state.namespaceId,
        scopeId,
        entered,
      );
      if (!res.ok) {
        const addedSet = new Set(added);
        state.scopeRels = state.scopeRels.filter(
          (r) => !(r.scopeId === scopeId && addedSet.has(r.cardId)),
        );
        state.setError(await api.failureMessage(res, "Failed to add cards to scope"));
      }
    }

    if (exited.length > 0) {
      const exitedSet = new Set(exited);
      const removed = state.scopeRels.filter(
        (r) => r.scopeId === scopeId && exitedSet.has(r.cardId),
      );
      state.scopeRels = state.scopeRels.filter(
        (r) => !(r.scopeId === scopeId && exitedSet.has(r.cardId)),
      );
      const res = await api.removeCardsFromScope(
        state.mutationFetcher,
        state.namespaceId,
        scopeId,
        exited,
      );
      if (!res.ok) {
        state.scopeRels = [...state.scopeRels, ...removed];
        state.setError(await api.failureMessage(res, "Failed to remove cards from scope"));
      }
    }
  }

  /**
   * Create a scope frame at the supplied rectangle and add the supplied overlapping cards to
   * the scope. The caller provides geometry and measured members.
   */
  async function handleCreateScopeArea(scopeId: string, rect: BoardRect, covers: string[] = []) {
    const res = await api.createScopeArea(state.mutationFetcher, state.namespaceId, scopeId, rect);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to add scope area"));
      return;
    }
    const stored = api.parseScopeArea(await res.json().catch(() => null));
    if (!stored) {
      state.setError("Failed to add scope area");
      return;
    }
    // Append the new frame without replacing other frames for this scope.
    state.scopeAreas = [...state.scopeAreas, stored];
    if (covers.length > 0) {
      await handleScopeMembershipChange(scopeId, { entered: covers, exited: [] });
    }
  }

  /**
   * Create a named scope, then frame it. Keep the scope if frame creation fails so the user
   * can retry placement.
   */
  async function handleCreateScopeWithArea(name: string, rect: BoardRect, covers: string[] = []) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await api.createScope(state.mutationFetcher, state.namespaceId, trimmed);
    if (!res.ok) {
      state.setError(await api.failureMessage(res, "Failed to create scope"));
      return;
    }
    const scopeId = readString(await res.json().catch(() => null), "id");
    if (scopeId === undefined) {
      state.setError("Failed to create scope");
      return;
    }
    state.scopes = [...state.scopes, { id: scopeId, name: trimmed }];
    await handleCreateScopeArea(scopeId, rect, covers);
  }

  /** Remove the frame while preserving all scope memberships. */
  async function handleDeleteScopeArea(scopeId: string, areaId: string) {
    const prev = state.scopeAreas;
    // Remove only the clicked frame's area ID.
    state.scopeAreas = state.scopeAreas.filter((a) => a.id !== areaId);
    const res = await api.deleteScopeArea(
      state.mutationFetcher,
      state.namespaceId,
      scopeId,
      areaId,
    );
    if (!res.ok) {
      state.scopeAreas = prev;
      state.setError("Failed to remove scope area");
    }
  }

  /** Create a scope by name, answering its id or the server's reason. */
  async function createScope(rawName: string): Promise<{ id: string } | { error: string }> {
    const name = rawName.trim();
    if (!name) return { error: "Scope name is required" };
    const res = await api.createScope(state.mutationFetcher, state.namespaceId, name);
    if (!res.ok) return { error: await api.failureMessage(res, "Failed to create scope") };
    const id = readString(await res.json().catch(() => null), "id");
    if (id === undefined) return { error: "Failed to create scope" };
    state.scopes = [...state.scopes, { id, name }];
    return { id };
  }

  async function renameScope(scopeId: string, rawName: string): Promise<{ error: string } | null> {
    const name = rawName.trim();
    if (!name) return { error: "Scope name is required" };
    const res = await api.renameScope(state.mutationFetcher, state.namespaceId, scopeId, name);
    if (!res.ok) return { error: await api.failureMessage(res, "Failed to rename scope") };
    state.scopes = state.scopes.map((scope) => (scope.id === scopeId ? { ...scope, name } : scope));
    return null;
  }

  /**
   * Remove a scope from this board, as the sidebar's `×` does. Answer the reason on failure
   * instead of raising the banner.
   */
  async function removeScope(scopeId: string): Promise<{ error: string } | null> {
    const res = await api.deleteScope(state.mutationFetcher, state.namespaceId, scopeId);
    if (!res.ok) return { error: await api.failureMessage(res, "Failed to delete scope") };
    state.scopes = state.scopes.filter((s) => s.id !== scopeId);
    state.scopeRels = state.scopeRels.filter((r) => r.scopeId !== scopeId);
    state.scopeAreas = state.scopeAreas.filter((a) => a.scopeId !== scopeId);
    if (state.sidebar.activeScope === scopeId) state.sidebar.activeScope = null;
    return null;
  }

  async function renameTaskspace(
    taskspaceId: string,
    rawName: string,
  ): Promise<{ error: string } | null> {
    const name = rawName.trim();
    if (!name) return { error: "Taskspace name is required" };
    const res = await api.renameTaskspace(
      state.mutationFetcher,
      state.namespaceId,
      taskspaceId,
      name,
    );
    if (!res.ok) return { error: await api.failureMessage(res, "Failed to rename taskspace") };
    const parsed = await res.json().catch(() => null);
    const path = readString(parsed, "path");
    state.taskspaces = state.taskspaces.map((taskspace) =>
      taskspace.id === taskspaceId
        ? { ...taskspace, name, ...(path !== undefined && { path }) }
        : taskspace,
    );
    return null;
  }

  /**
   * Delete a taskspace, and with it the directory when the server manages it. Answer what
   * happened to the directory, or the reason on failure.
   */
  async function deleteTaskspace(
    taskspaceId: string,
  ): Promise<{ directory: string } | { error: string }> {
    const res = await api.deleteTaskspace(state.mutationFetcher, state.namespaceId, taskspaceId);
    if (!res.ok) return { error: await api.failureMessage(res, "Failed to delete taskspace") };
    const directory = readString(await res.json().catch(() => null), "directory") ?? "kept";
    state.taskspaces = state.taskspaces.filter(({ id }) => id !== taskspaceId);
    state.taskspaceTree.prune(state.taskspaces.map(({ id }) => id));
    return { directory };
  }

  return {
    createScope,
    renameScope,
    removeScope,
    renameTaskspace,
    deleteTaskspace,
    createTaskspace,
    handleLinkScope,
    handleCreateScopeWithFile,
    handleScopeMembershipChange,
    handleCreateScopeArea,
    handleCreateScopeWithArea,
    handleDeleteScopeArea,
  };
}
