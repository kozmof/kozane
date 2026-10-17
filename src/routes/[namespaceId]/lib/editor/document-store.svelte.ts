import { history, position, query, rendering, scan, store } from "@kozmof/reed";
import { GraphemeCache } from "./graphemes.js";
import type { ByteOffset, ContentChangeEvent, SelectionRange } from "@kozmof/reed";

type DocumentState = ReturnType<ReturnType<typeof store.createDocumentStore>["getSnapshot"]>;
type ReedStore = ReturnType<typeof store.createDocumentStoreWithEvents>;

/** A caret or a selection end, in the coordinates the render layer draws in. */
export type Caret = {
  /** 0-indexed line. */
  line: number;
  /** 0-indexed column, counted in characters rather than bytes. */
  column: number;
};

export type VisibleLine = {
  lineNumber: number;
  content: string;
};

/**
 * Time window for grouping consecutive compatible edits into one undo entry. A longer pause,
 * a different edit kind, or a different location starts a new entry.
 */
const UNDO_GROUP_MS = 300;

/** Ordered so `start` is never after `end`, whichever way the selection was made. */
export function orderCarets(a: Caret, b: Caret): { start: Caret; end: Caret } {
  const aFirst = a.line < b.line || (a.line === b.line && a.column <= b.column);
  return aFirst ? { start: a, end: b } : { start: b, end: a };
}

export function sameCaret(a: Caret, b: Caret): boolean {
  return a.line === b.line && a.column === b.column;
}

/**
 * Bridge one Reed document store to Svelte runes. Refresh a `$state.raw` snapshot from the
 * store subscription so immutable Reed state keeps its reference identity.
 *
 * The editor uses line and column coordinates. Columns count UTF-16 code units, while Reed
 * positions are UTF-8 byte offsets. Convert between them here and use Reed's types directly.
 *
 * Keep carets on grapheme boundaries so combining marks and emoji sequences move
 * and delete together. Positions inside a cluster snap backward to its start.
 */
export class EditorDocument {
  #store: ReedStore;
  #graphemes = new GraphemeCache();
  #unsubscribe: (() => void) | null = null;
  #unsubscribeContent: (() => void) | null = null;

  /**
   * Immutable Reed snapshot, temporarily undefined during construction. Initialize it before
   * returning the instance and expose it through the checked `state` getter. Keep it raw to
   * preserve reference identity.
   */
  #current = $state.raw<DocumentState | undefined>(undefined);

  /**
   * Current Reed state, replaced on every edit. Throw if initialization order leaves it
   * unavailable so failures identify the missing snapshot directly.
   */
  get state(): DocumentState {
    const current = this.#current;
    if (current === undefined) throw new Error("EditorDocument read before its first snapshot");
    return current;
  }

  /** Text last read or saved. Reed revisions also advance on undo/redo. */
  #savedContent = $state("");
  #savedByteLength = $state(0);

  #dirty = $derived(
    this.state.pieceTable.totalLength !== this.#savedByteLength ||
      this.text() !== this.#savedContent,
  );

  constructor(content: string) {
    this.#store = store.createDocumentStoreWithEvents({ content, undoGroupTimeout: UNDO_GROUP_MS });
    this.#current = this.#store.getSnapshot();
    this.markSaved();
    this.#unsubscribeContent = this.#store.addEventListener("content-change", (event) => {
      this.#updateText(event);
    });
    this.#unsubscribe = this.#store.subscribe(() => {
      this.#current = this.#store.getSnapshot();
    });
  }

  /**
   * Drops the subscription. The store holds a reconciliation scheduler that keeps running
   * otherwise, so an editor closed without this leaves work behind for a file nobody has
   * open.
   */
  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#unsubscribeContent?.();
    this.#unsubscribeContent = null;
    this.#graphemes.clear();
    this.#store.dispose();
  }

  get lineCount(): number {
    return query.getLineCount(this.state);
  }

  get canUndo(): boolean {
    return history.canUndo(this.state);
  }

  get canRedo(): boolean {
    return history.canRedo(this.state);
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  /** Record the content sent to disk, which may precede edits made during an async save. */
  markSaved(content = this.text()): void {
    this.#savedContent = content;
    this.#savedByteLength = byteLength(content);
  }

  /**
   * Return only viewport lines so rendered DOM size follows panel height rather than document
   * length.
   */
  visibleLines(startLine: number, visibleLineCount: number, overscan = 4): VisibleLine[] {
    const result = rendering.getVisibleLines(this.state, {
      startLine: Math.max(0, startLine),
      visibleLineCount,
      overscan,
    });
    // Narrowed to the two fields the panel draws. Reed's own `VisibleLine` also carries
    // byte offsets and a newline flag, which are its coordinates rather than this one's.
    return result.lines.map(({ lineNumber, content }) => ({ lineNumber, content }));
  }

  /** One line's text, or `""` for a line that is out of range. */
  lineText(line: number): string {
    return rendering.getLineContent(this.state, line) ?? "";
  }

  #textTable: DocumentState["pieceTable"] | undefined;
  #textValue = "";
  #textEdit: { base: string; from: number; to: number; inserted: string } | undefined;

  #updateText({ action, prevState, nextState, affectedRanges }: ContentChangeEvent): void {
    // History can replace the table without a content event. Rebuild lazily in text()
    // if this cache does not describe the state immediately before the edit.
    if (action.type === "APPLY_REMOTE" || this.#textTable !== prevState.pieceTable) return;
    const charOffset = (byte: ByteOffset): number | undefined => {
      const at = rendering.positionToLineColumn(prevState, byte);
      return at ? query.getCharStartOffset(prevState, at.line) + at.column : undefined;
    };
    const from = charOffset(action.start);
    const to = action.type === "INSERT" ? from : charOffset(action.end);
    if (from === undefined || to === undefined) return;
    const inserted =
      action.type === "DELETE"
        ? ""
        : query.getText(nextState.pieceTable, action.start, affectedRanges[0][1]);
    let edit = this.#textEdit;
    // Keep nearby edits over an unchanged base. Slicing each preceding concatenation
    // can flatten the full document string on every keystroke.
    if (!edit || from < edit.from - 4096 || to > edit.from + edit.inserted.length + 4096) {
      edit = { base: this.#textValue, from, to, inserted };
    } else {
      const start = Math.min(from, edit.from);
      const end = edit.to + Math.max(0, to - edit.from - edit.inserted.length);
      const window =
        edit.base.slice(start, edit.from) + edit.inserted + edit.base.slice(edit.to, end);
      edit = {
        base: edit.base,
        from: start,
        to: end,
        inserted: window.slice(0, from - start) + inserted + window.slice(to - start),
      };
    }
    this.#textEdit = edit;
    this.#textValue = edit.base.slice(0, edit.from) + edit.inserted + edit.base.slice(edit.to);
    this.#textTable = nextState.pieceTable;
  }

  /** Reuse text across reads and local edits, and decode once after an uncached history change. */
  text(): string {
    const table = this.state.pieceTable;
    if (table !== this.#textTable) {
      this.#textValue = scan.getValue(table);
      this.#textTable = table;
      this.#textEdit = undefined;
    }
    return this.#textValue;
  }

  /** Clamp to the document and snap backward to the start of a grapheme cluster. */
  clamp({ line, column }: Caret): Caret {
    const lastLine = Math.max(0, this.lineCount - 1);
    const safeLine = Math.min(Math.max(0, line), lastLine);
    return {
      line: safeLine,
      column: this.#graphemes.snap(safeLine, this.lineText(safeLine), column),
    };
  }

  /** Move backward by one whole grapheme for leftward movement and backspace. */
  columnBefore(line: number, column: number): number {
    const text = this.lineText(line);
    const index = this.#graphemes.index(line, text, column);
    return this.#graphemes.boundaries(line, text)[Math.max(0, index - 1)];
  }

  /** Move forward by one whole grapheme, paired with {@link columnBefore}. */
  columnAfter(line: number, column: number): number {
    const text = this.lineText(line);
    const index = this.#graphemes.index(line, text, column);
    const boundaries = this.#graphemes.boundaries(line, text);
    return boundaries[Math.min(boundaries.length - 1, index + 1)];
  }

  #byteOffset({ line, column }: Caret): ByteOffset {
    // Resolve offsets at whole grapheme boundaries, including clicks inside a cluster.
    const offset = rendering.lineColumnToPosition(
      this.state,
      line,
      this.#graphemes.snap(line, this.lineText(line), column),
    );
    // Clamp unresolved carets beyond the document to its end.
    return offset ?? position.byteOffset(this.state.pieceTable.totalLength);
  }

  #caretAt(byteOffset: number): Caret {
    // Use the branded byte-offset constructor so Reed's offset type remains checked.
    const at = rendering.positionToLineColumn(this.state, position.byteOffset(byteOffset));
    return at ?? { line: 0, column: 0 };
  }

  /**
   * Record the pre-edit selection on the action so undo restores the caret near the text it
   * changes.
   */
  #selectionAt(byteOffset: number): [SelectionRange] {
    const at = position.byteOffset(byteOffset);
    // Use a tuple to satisfy Reed's non-empty selection requirement.
    return [{ anchor: at, head: at }];
  }

  /** Inserts `text` at `at`, and answers where the caret ends up. */
  insert(at: Caret, text: string): Caret {
    const start = this.#byteOffset(at);
    this.#store.dispatch(
      store.DocumentActions.insert(position.byteOffset(start), text, this.#selectionAt(start)),
    );
    return this.#caretAt(start + byteLength(text));
  }

  /**
   * Delete `start` through `end` and return the resulting caret position. Record
   * `caretBefore` for undo. It defaults to `start`, but backspace must pass the caret at
   * `end`.
   */
  delete(start: Caret, end: Caret, caretBefore: Caret = start): Caret {
    const from = this.#byteOffset(start);
    const to = this.#byteOffset(end);
    if (from === to) return start;
    this.#store.dispatch(
      store.DocumentActions.delete(
        position.byteOffset(from),
        position.byteOffset(to),
        this.#selectionAt(this.#byteOffset(caretBefore)),
      ),
    );
    return this.#caretAt(from);
  }

  /**
   * Replaces `start`–`end` with `text` in one entry, so one undo takes it all back.
   * `caretBefore` carries the same meaning as on {@link delete}.
   */
  replace(start: Caret, end: Caret, text: string, caretBefore: Caret = start): Caret {
    const from = this.#byteOffset(start);
    const to = this.#byteOffset(end);
    this.#store.dispatch(
      store.DocumentActions.replace(
        position.byteOffset(from),
        position.byteOffset(to),
        text,
        this.#selectionAt(this.#byteOffset(caretBefore)),
      ),
    );
    return this.#caretAt(from + byteLength(text));
  }

  /** Read only the selected byte range, preserving Unicode boundaries and line endings. */
  textBetween(start: Caret, end: Caret): string {
    return query.getText(this.state.pieceTable, this.#byteOffset(start), this.#byteOffset(end));
  }

  /** The caret this document's own selection points at, or null when it has none. */
  selectionCaret(): Caret | null {
    const head = query.getSelectionHead(this.state);
    return head == null ? null : this.#caretAt(head);
  }

  /** Undo one edit and return its recorded caret position, or null when nothing can be undone. */
  undo(): Caret | null {
    if (!this.canUndo) return null;
    this.#store.dispatch(store.DocumentActions.undo());
    return this.selectionCaret();
  }

  /** Redo one edit and return its caret position, paired with {@link undo}. */
  redo(): Caret | null {
    if (!this.canRedo) return null;
    this.#store.dispatch(store.DocumentActions.redo());
    return this.selectionCaret();
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
