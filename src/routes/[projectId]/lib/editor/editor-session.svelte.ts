import type { TaskspaceFileTree } from "$lib/types";
import { failureMessage, fetchTaskspaceFile, saveTaskspaceFile } from "../project-api.js";
import { findStaticNode } from "../taskspace-static.js";
import { type Caret, EditorDocument } from "./document-store.svelte.js";

export type EditorSessionContext = {
  fetcher: typeof fetch;
  projectId: string;
  /** A static export's embedded taskspace trees — see {@link TaskspaceTreeContext}. */
  staticFiles?: Record<string, TaskspaceFileTree>;
};

/** Why a static export has no content to show for a file that is otherwise there. */
const SKIP_REASON_MESSAGE: Record<"too-large" | "not-text" | "budget" | "unreadable", string> = {
  "too-large": "This file is too large to open.",
  "not-text": "This file is not text and cannot be opened.",
  budget: "This export's size budget ran out before reaching this file.",
  unreadable: "This file could not be read when the export was built.",
};

/** Which file an editor is open on. */
export type OpenFileRef = {
  taskspaceId: string;
  taskspaceName: string;
  /** `/`-separated, relative to the taskspace root. */
  path: string;
};

/**
 * The file the editor has open, and everything about it that is not the text itself.
 *
 * Loading, saving, and the two ways either can go wrong are here rather than in the
 * component so they can be tested without rendering anything. The document is a
 * {@link EditorDocument}; this owns its lifecycle, which matters because a Reed store left
 * subscribed keeps a reconciliation scheduler alive for a file nobody has open.
 */
export class EditorSession {
  file = $state<OpenFileRef | null>(null);
  doc = $state.raw<EditorDocument | null>(null);
  caret = $state<Caret>({ line: 0, column: 0 });
  anchor = $state<Caret | null>(null);

  loading = $state(false);
  saving = $state(false);
  error = $state<string | null>(null);
  /**
   * Set when a save was refused because the file changed on disk. Held separately from
   * `error` because it is the one failure with something to offer beyond an apology —
   * the panel puts a "reload from disk" beside it.
   */
  conflict = $state(false);

  /** What was read from disk, to be handed back on save so the server can check it. */
  #signature: string | null = null;

  get isOpen(): boolean {
    return this.file !== null;
  }

  get dirty(): boolean {
    return this.doc?.dirty === true;
  }

  /**
   * Opens `ref`, replacing whatever was open. The previous document is disposed rather
   * than dropped, so a session of opening one file after another does not accumulate a
   * scheduler per file.
   */
  async open(ctx: EditorSessionContext, ref: OpenFileRef): Promise<void> {
    this.#reset();
    this.file = ref;

    const staticTree = ctx.staticFiles?.[ref.taskspaceId];
    if (staticTree) {
      const node = findStaticNode(staticTree, ref.path);
      if (node?.kind === "file") this.#adopt(node.content, null);
      else if (node?.kind === "file-skipped") this.error = SKIP_REASON_MESSAGE[node.reason];
      else this.error = "File not found";
      return;
    }

    this.loading = true;

    try {
      const res = await fetchTaskspaceFile(ctx.fetcher, ctx.projectId, ref.taskspaceId, ref.path);
      if (!res.ok) {
        this.error = await failureMessage(res, "Failed to open file");
        this.loading = false;
        return;
      }
      const body = await res.json();
      this.#adopt(typeof body?.content === "string" ? body.content : "", body?.signature ?? null);
    } catch {
      this.error = "Failed to open file";
    } finally {
      this.loading = false;
    }
  }

  /**
   * Re-reads the file, discarding whatever is in the editor. What the conflict banner
   * offers, and the only way out of one short of closing the file.
   */
  async reload(ctx: EditorSessionContext): Promise<void> {
    const ref = this.file;
    if (!ref) return;
    await this.open(ctx, ref);
  }

  async save(ctx: EditorSessionContext): Promise<boolean> {
    const ref = this.file;
    const doc = this.doc;
    if (!ref || !doc || this.saving) return false;

    this.saving = true;
    this.error = null;
    this.conflict = false;

    // Read before the request rather than after it: an edit made while the save is in
    // flight must leave the file dirty, and it would not if the revision were taken from
    // the document once the answer came back.
    const revision = doc.state.revision;

    try {
      const res = await saveTaskspaceFile(ctx.fetcher, ctx.projectId, ref.taskspaceId, {
        path: ref.path,
        content: doc.text(),
        signature: this.#signature,
      });
      if (!res.ok) {
        this.conflict = res.status === 409;
        this.error = await failureMessage(res, "Failed to save file");
        return false;
      }
      const body = await res.json();
      this.#signature = body?.signature ?? null;
      doc.savedRevision = revision;
      return true;
    } catch {
      this.error = "Failed to save file";
      return false;
    } finally {
      this.saving = false;
    }
  }

  close(): void {
    this.#reset();
  }

  #adopt(content: string, signature: string | null): void {
    this.doc = new EditorDocument(content);
    this.#signature = signature;
    this.caret = { line: 0, column: 0 };
    this.anchor = null;
  }

  #reset(): void {
    this.doc?.dispose();
    this.doc = null;
    this.file = null;
    this.caret = { line: 0, column: 0 };
    this.anchor = null;
    this.loading = false;
    this.saving = false;
    this.error = null;
    this.conflict = false;
    this.#signature = null;
  }
}
