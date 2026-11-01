import type { NamespaceState } from "../namespace-state.svelte.js";
import type { EditorSession, EditorSessionContext } from "./editor/editor-session.svelte.js";

type BoardFilesHost = {
  s: NamespaceState;
  editor: EditorSession;
  /** Read on use, because namespace navigation changes the namespace and fetcher. */
  context: () => EditorSessionContext;
  closeFilePalette: () => void;
  /** Create a scope, taskspace, and file, answering where the file is, or null on failure. */
  createScopeWithFile: (names: {
    scope: string;
    taskspace: string;
    file: string;
  }) => Promise<{ taskspaceId: string; taskspaceName: string; path: string } | null | undefined>;
};

/** The board's ways of opening a taskspace file in the editor. */
export function createBoardFiles({
  s,
  editor,
  context,
  closeFilePalette,
  createScopeWithFile,
}: BoardFilesHost) {
  function open(taskspaceId: string, taskspaceName: string, path: string): void {
    void editor.open(context(), { taskspaceId, taskspaceName, path });
  }

  /**
   * Close the palette before opening its selected file so the editor receives focus and
   * outside-press events correctly.
   */
  function openFromPalette(taskspaceId: string, taskspaceName: string, path: string): void {
    closeFilePalette();
    open(taskspaceId, taskspaceName, path);
  }

  /**
   * Open a file from a scope frame's icon. Resolve the taskspace name here for the editor
   * title using the same rows that supply the canvas icons.
   */
  function openFromFrame(taskspaceId: string, path: string): void {
    const taskspace = s.taskspaces.find(({ id }) => id === taskspaceId);
    if (!taskspace) return;
    open(taskspaceId, taskspace.name, path);
  }

  /** Create a scope, taskspace, and file, then open the new file. */
  async function createFromPalette(names: {
    scope: string;
    taskspace: string;
    file: string;
  }): Promise<void> {
    const made = await createScopeWithFile(names);
    if (!made) return; // the action has already said why
    openFromPalette(made.taskspaceId, made.taskspaceName, made.path);
  }

  return { open, openFromPalette, openFromFrame, createFromPalette };
}
