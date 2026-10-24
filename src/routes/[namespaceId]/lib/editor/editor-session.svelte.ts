import type { TaskspaceFileTree } from "$lib/types";
import { failureMessage, fetchTaskspaceFile, saveTaskspaceFile } from "../namespace-api.js";
import { findStaticNode } from "../taskspace-static.js";
import { type Caret, EditorDocument } from "./document-store.svelte.js";

export type EditorSessionContext = {
  fetcher: typeof fetch;
  namespaceId: string;
  /** Embedded taskspace trees for static export. See {@link TaskspaceTreeContext}. */
  staticFiles?: Record<string, TaskspaceFileTree>;
};

/** Reason an exported file is listed without readable content. */
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

/** See {@link EditorSession.leaveGuard}. */
export type LeaveGuard = () => Promise<boolean>;

export type SaveOptions = {
  /** Let the request outlive the page, for a save sent as the tab closes. Small files only. */
  keepalive?: boolean;
};

/**
 * Manage the open file's loading, saving, errors, and {@link EditorDocument} lifecycle.
 * Dispose subscriptions when closing so the document scheduler does not remain active.
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
   * Whether saving was refused because the file changed on disk. Keep this separate from
   * other errors so the panel can offer reloading.
   */
  conflict = $state(false);

  /** File-version signature returned on save to detect changes on disk. */
  #signature: string | null = null;

  /**
   * Saves in flight, by file. Kept across opens and closes, so a file reopened by way of
   * another still waits for its save instead of reading what was on disk before it.
   */
  #inFlight = new Map<string, Promise<boolean>>();

  /** Counts opens and closes, so an open that waited can tell a later one replaced it. */
  #opens = 0;

  /**
   * Counts calls to {@link open}, so a request still waiting on {@link leaveGuard} can tell
   * a newer one came in. The newest request wins, as the file clicked last should.
   */
  #requests = 0;

  #leaveGuard: LeaveGuard | null = null;

  /**
   * Asked before opening another file over unsaved changes, so the panel can save or confirm
   * first. Resolves false to stay on the current file. Without one, the changes are dropped.
   */
  get leaveGuard(): LeaveGuard | null {
    return this.#leaveGuard;
  }

  /**
   * Install `guard` as {@link leaveGuard}. The returned function removes it, unless another
   * guard has been set since, which then stays in place.
   */
  setLeaveGuard(guard: LeaveGuard): () => void {
    this.#leaveGuard = guard;
    return () => {
      if (this.#leaveGuard === guard) this.#leaveGuard = null;
    };
  }

  get isOpen(): boolean {
    return this.file !== null;
  }

  get dirty(): boolean {
    return this.doc?.dirty === true;
  }

  /**
   * Open `ref` and dispose the previous document to release its scheduler.
   */
  async open(ctx: EditorSessionContext, ref: OpenFileRef): Promise<void> {
    const request = ++this.#requests;
    // Reopening the same file is a reload, which discards edits on purpose.
    if (this.dirty && this.leaveGuard && this.file && fileKey(this.file) !== fileKey(ref)) {
      const asking = this.#opens;
      if (!(await this.leaveGuard())) return;
      if (this.#requests !== request) return;
      // Another file opened meanwhile. A close, which the guard's own save can end in, leaves
      // nothing to replace, so the click still opens its file.
      if (this.#opens !== asking && this.isOpen) return;
    }

    const pending = this.#inFlight.get(fileKey(ref));
    this.#reset();
    this.file = ref;
    const opening = this.#opens;

    // Reopening a file while its save runs would read what was on disk before that save, and
    // the next save would then be refused as a conflict. Let the save land first.
    if (pending) {
      this.loading = true;
      await pending;
      if (this.#opens !== opening) return;
    }

    const staticTree = ctx.staticFiles?.[ref.taskspaceId];
    if (staticTree) {
      const node = findStaticNode(staticTree, ref.path);
      if (node?.kind === "file") this.#adopt(node.content, null);
      else if (node?.kind === "file-skipped") this.error = SKIP_REASON_MESSAGE[node.reason];
      else this.error = "File not found";
      this.loading = false;
      return;
    }

    this.loading = true;

    // A file opened or closed while this one loads replaces it. Leave that one's document,
    // errors, and loading flag alone, or a slow read would show its text under another path.
    const current = () => this.#opens === opening;
    try {
      const res = await fetchTaskspaceFile(ctx.fetcher, ctx.namespaceId, ref.taskspaceId, ref.path);
      if (!res.ok) {
        const message = await failureMessage(res, "Failed to open file");
        if (current()) this.error = message;
        return;
      }
      const body = await res.json();
      if (!current()) return;
      this.#adopt(typeof body?.content === "string" ? body.content : "", body?.signature ?? null);
    } catch {
      if (current()) this.error = "Failed to open file";
    } finally {
      if (current()) this.loading = false;
    }
  }

  /**
   * Reload the file and discard unsaved edits. The conflict banner offers this action.
   */
  async reload(ctx: EditorSessionContext): Promise<void> {
    const ref = this.file;
    if (!ref) return;
    await this.open(ctx, ref);
  }

  /**
   * Write the open document. Resolves true when the server took the content, even if the
   * file was closed or replaced meanwhile, and false when nothing was written. While a save
   * runs, wait for it, then write what it did not cover.
   */
  save(ctx: EditorSessionContext, options: SaveOptions = {}): Promise<boolean> {
    const ref = this.file;
    const doc = this.doc;
    if (!ref || !doc) return Promise.resolve(false);
    if (this.saving) {
      const running = this.#inFlight.get(fileKey(ref));
      if (!running) return Promise.resolve(false);
      // A failed or refused save would fail again, and another file is not this one's.
      return running.then((wrote) =>
        wrote && this.doc === doc && doc.dirty && !this.conflict ? this.save(ctx, options) : wrote,
      );
    }

    this.saving = true;
    this.error = null;
    this.conflict = false;

    const key = fileKey(ref);
    const saving = this.#write(ctx, ref, doc, options).finally(() => {
      if (this.#inFlight.get(key) === saving) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, saving);
    return saving;
  }

  /** Wait for the open file's save in flight to finish. Resolves at once when none is. */
  async settled(): Promise<void> {
    if (this.file) await this.#inFlight.get(fileKey(this.file));
  }

  async #write(
    ctx: EditorSessionContext,
    ref: OpenFileRef,
    doc: EditorDocument,
    options: SaveOptions,
  ): Promise<boolean> {
    // Capture exactly the content sent so edits made during the request remain dirty.
    const content = doc.text();

    try {
      const res = await saveTaskspaceFile(
        ctx.fetcher,
        ctx.namespaceId,
        ref.taskspaceId,
        { path: ref.path, content, signature: this.#signature },
        options,
      );
      if (!res.ok) {
        const message = await failureMessage(res, "Failed to save file");
        if (this.doc !== doc) return false;
        this.conflict = res.status === 409;
        this.error = message;
        return false;
      }
      const body = await res.json();
      // The file was closed or another opened while this save ran. Its state is no longer
      // the session's, so leave the new file's signature, errors, and saving flag alone.
      if (this.doc !== doc) return true;
      this.#signature = body?.signature ?? null;
      doc.markSaved(content);
      return true;
    } catch {
      if (this.doc === doc) this.error = "Failed to save file";
      return false;
    } finally {
      if (this.doc === doc) this.saving = false;
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
    this.#opens++;
  }
}

function fileKey({ taskspaceId, path }: OpenFileRef): string {
  return JSON.stringify([taskspaceId, path]);
}
