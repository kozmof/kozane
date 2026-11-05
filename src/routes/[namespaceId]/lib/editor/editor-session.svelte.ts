import type { KozaneBackend, MutationOptions as SaveOptions } from "$lib/backend/contract.js";
import { BackendError } from "$lib/backend/contract.js";
import type { TaskspaceFileTree } from "$lib/types";
import { failureMessage, fetchTaskspaceFile, saveTaskspaceFile } from "../namespace-api.js";
import {
  findStaticNode,
  STATIC_FILE_SKIP_MESSAGES as SKIP_REASON_MESSAGE,
} from "$lib/backend/static-files.js";
import { type Caret, EditorDocument } from "./document-store.svelte.js";

export type EditorSessionContext = {
  fetcher: typeof fetch;
  backend?: Pick<KozaneBackend, "taskspaces">;
  namespaceId: string;
  /** Embedded taskspace trees for reading files in a static export. */
  staticFiles?: Record<string, TaskspaceFileTree>;
};

/** Which file an editor is open on. */
export type OpenFileRef = {
  taskspaceId: string;
  taskspaceName: string;
  /** `/`-separated, relative to the taskspace root. */
  path: string;
};

/** See {@link EditorSession.switchGuard}. */
export type SwitchGuard = () => Promise<boolean>;

/**
 * Result of {@link EditorSession.flush}. A replaced or closed file returns `replaced`
 * without saving the new document.
 */
export type FlushOutcome = "saved" | "unsaved" | "replaced";

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

  /** File-version signature from the last read or save, used to detect changes on disk. */
  #signature: string | null = null;

  /**
   * Pending saves keyed by taskspace and path. Keep them across opens and closes so
   * reopening a file waits for its save before reading from disk.
   */
  #inFlight = new Map<string, Promise<boolean>>();

  /**
   * Controller for the current document session. Opening or closing a file aborts pending
   * reads and lets asynchronous work detect that its session has ended.
   */
  #generation = new AbortController();

  /**
   * Count open requests so a request awaiting {@link switchGuard} can detect a newer one.
   * The most recent open request wins.
   */
  #requests = 0;

  #switchGuard: SwitchGuard | null = null;

  /**
   * Asked before opening another file over unsaved changes, so the panel can save or confirm
   * first. Resolves false to stay on the current file. Without one, the changes are dropped.
   * Page navigation has its own guard, in `leave-guard.ts`.
   */
  get switchGuard(): SwitchGuard | null {
    return this.#switchGuard;
  }

  /**
   * Install `guard` as {@link switchGuard}. The returned function removes it, unless another
   * guard has been set since, which then stays in place.
   */
  setSwitchGuard(guard: SwitchGuard): () => void {
    this.#switchGuard = guard;
    return () => {
      if (this.#switchGuard === guard) this.#switchGuard = null;
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
    if (this.dirty && this.switchGuard && this.file && fileKey(this.file) !== fileKey(ref)) {
      const asking = this.#generation.signal;
      if (!(await this.switchGuard())) return;
      if (this.#requests !== request) return;
      // Cancel if another document session opened while the guard ran. If the guard
      // closed the file, continue opening the requested file.
      if (asking.aborted && this.isOpen) return;
    }

    const pending = this.#inFlight.get(fileKey(ref));
    this.#reset();
    this.file = ref;
    const opening = this.#generation.signal;

    // Reopening a file while its save runs would read what was on disk before that save, and
    // the next save would then be refused as a conflict. Let the save land first.
    if (pending) {
      this.loading = true;
      await pending;
      if (opening.aborted) return;
    }

    const staticTree = ctx.backend ? undefined : ctx.staticFiles?.[ref.taskspaceId];
    if (staticTree) {
      const node = findStaticNode(staticTree, ref.path);
      if (node?.kind === "file") this.#adopt(node.content, null);
      else if (node?.kind === "file-skipped") this.error = SKIP_REASON_MESSAGE[node.reason];
      else this.error = "File not found";
      this.loading = false;
      return;
    }

    this.loading = true;

    // Ignore results after this session ends so a slow read cannot overwrite the next
    // session's document, error, or loading state.
    const current = () => !opening.aborted;
    try {
      let body;
      if (ctx.backend) {
        const api = ctx.backend.taskspaces;
        if (!api) throw new BackendError("unavailable", "Taskspaces are not available");
        body = await api.readFile(ctx.namespaceId, ref.taskspaceId, ref.path, { signal: opening });
      } else {
        const res = await fetchTaskspaceFile(
          ctx.fetcher,
          ctx.namespaceId,
          ref.taskspaceId,
          ref.path,
          opening,
        );
        if (!res.ok) {
          const message = await failureMessage(res, "Failed to open file");
          if (current()) this.error = message;
          return;
        }
        body = await res.json();
      }
      if (!current()) return;
      this.#adopt(typeof body?.content === "string" ? body.content : "", body?.signature ?? null);
    } catch (error) {
      if (current())
        this.error = error instanceof BackendError ? error.message : "Failed to open file";
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
   * Save the open document. Resolve true after a successful write, even if the document
   * was closed or replaced during the request. Resolve false if no document is open or
   * the write fails. If a save is pending, wait for it and save remaining edits only
   * if that write succeeded and the same document is still open.
   */
  save(ctx: EditorSessionContext, options: SaveOptions = {}): Promise<boolean> {
    const ref = this.file;
    const doc = this.doc;
    if (!ref || !doc) return Promise.resolve(false);
    const key = fileKey(ref);
    if (this.saving) {
      const running = this.#inFlight.get(key);
      if (!running) return Promise.resolve(false);
      // Retry remaining edits only after a successful save of the same document.
      // Track the queued save now so reopening the file waits for it too.
      return this.#track(
        key,
        running.then((wrote) =>
          wrote && this.doc === doc && doc.dirty && !this.conflict
            ? this.save(ctx, options)
            : wrote,
        ),
      );
    }

    this.saving = true;
    this.error = null;
    this.conflict = false;
    return this.#track(key, this.#write(ctx, ref, doc, options));
  }

  /** Record `saving` as the file's save in flight until it ends. */
  #track(key: string, saving: Promise<boolean>): Promise<boolean> {
    const tracked = saving.finally(() => {
      if (this.#inFlight.get(key) === tracked) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, tracked);
    return tracked;
  }

  /**
   * Wait for all pending saves of the current file, including saves queued by {@link save}.
   * Resolve immediately if the file has no pending saves.
   */
  async settled(): Promise<void> {
    if (!this.file) return;
    const key = fileKey(this.file);
    for (let running = this.#inFlight.get(key); running; running = this.#inFlight.get(key))
      await running;
  }

  /**
   * Save remaining edits after pending saves finish. Return `replaced` if the document
   * session changes while waiting. Leave conflicts unsaved so the user can resolve them.
   */
  async flush(ctx: EditorSessionContext): Promise<FlushOutcome> {
    // Track the document session so reloading the same path also counts as replacement.
    const leaving = this.#generation.signal;
    await this.settled();
    if (leaving.aborted) return "replaced";
    if (this.dirty && !this.conflict) await this.save(ctx);
    if (leaving.aborted) return "replaced";
    return this.dirty ? "unsaved" : "saved";
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
      let body;
      if (ctx.backend) {
        const api = ctx.backend.taskspaces;
        if (!api) throw new BackendError("unavailable", "Taskspaces are not available");
        body = await api.saveFile(
          ctx.namespaceId,
          ref.taskspaceId,
          { path: ref.path, content, signature: this.#signature },
          options,
        );
      } else {
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
        body = await res.json();
      }
      // The file was closed or another opened while this save ran. Its state is no longer
      // the session's, so leave the new file's signature, errors, and saving flag alone.
      if (this.doc !== doc) return true;
      this.#signature = body?.signature ?? null;
      doc.markSaved(content);
      return true;
    } catch (error) {
      if (this.doc === doc) {
        this.conflict = error instanceof BackendError && error.code === "conflict";
        this.error = error instanceof BackendError ? error.message : "Failed to save file";
      }
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
    this.#generation.abort();
    this.#generation = new AbortController();
  }
}

function fileKey({ taskspaceId, path }: OpenFileRef): string {
  return JSON.stringify([taskspaceId, path]);
}
