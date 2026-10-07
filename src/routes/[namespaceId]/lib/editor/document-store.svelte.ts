import { history, position, query, rendering, scan, store } from "@kozmof/reed";
import type { SelectionRange } from "@kozmof/reed";

type DocumentState = ReturnType<ReturnType<typeof store.createDocumentStore>["getSnapshot"]>;
type ReedStore = ReturnType<typeof store.createDocumentStore>;

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
 * Keep carets on code-point boundaries. `clamp`, `columnBefore`, and `columnAfter` prevent a
 * column from splitting a surrogate pair. This editor snaps such columns backward to the
 * character's start, matching click placement. Reed's own conversion snaps forward, so the
 * explicit backward snap is still needed.
 */
export class EditorDocument {
  #store: ReedStore;
  #unsubscribe: (() => void) | null = null;

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

  /**
   * The revision the file was last read or saved at. What `dirty` is measured against, so
   * an edit and its undo leave the file reported as unmodified again.
   */
  savedRevision = $state(0);

  constructor(content: string) {
    this.#store = store.createDocumentStore({ content, undoGroupTimeout: UNDO_GROUP_MS });
    this.#current = this.#store.getSnapshot();
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
    this.#store.dispose?.();
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
    return this.state.revision !== this.savedRevision;
  }

  /** Marks the current revision as what is on disk. Called after a save. */
  markSaved(): void {
    this.savedRevision = this.state.revision;
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

  /** Read the whole document in O(n) time for saving, outside the rendering path. */
  text(): string {
    return scan.getValue(this.state.pieceTable);
  }

  /**
   * Clamp the caret to the document, its line, and a character boundary. Move positions
   * inside a surrogate pair back to the character's start so rendering and Reed edits use
   * valid boundaries.
   */
  clamp({ line, column }: Caret): Caret {
    const lastLine = Math.max(0, this.lineCount - 1);
    const safeLine = Math.min(Math.max(0, line), lastLine);
    return { line: safeLine, column: snapColumn(this.lineText(safeLine), column) };
  }

  /**
   * Return the column one character before `column` for leftward movement or backspace.
   * Preserve surrogate pairs.
   */
  columnBefore(line: number, column: number): number {
    const text = this.lineText(line);
    const at = snapColumn(text, column);
    if (at <= 0) return 0;
    return isLowSurrogate(text.charCodeAt(at - 1)) && isHighSurrogate(text.charCodeAt(at - 2))
      ? at - 2
      : at - 1;
  }

  /** Move one character forward, paired with {@link columnBefore}. */
  columnAfter(line: number, column: number): number {
    const text = this.lineText(line);
    const at = snapColumn(text, column);
    if (at >= text.length) return text.length;
    return isHighSurrogate(text.charCodeAt(at)) && isLowSurrogate(text.charCodeAt(at + 1))
      ? at + 2
      : at + 1;
  }

  #byteOffset({ line, column }: Caret): number {
    // Snap every caret before resolving its offset so a position inside a surrogate pair
    // resolves to the character's start consistently.
    const offset = rendering.lineColumnToPosition(
      this.state,
      line,
      snapColumn(this.lineText(line), column),
    );
    // Clamp unresolved carets beyond the document to its end.
    return offset ?? this.state.pieceTable.totalLength;
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

  /**
   * Read text between two carets in O(n) document time. Use Reed's line offsets to account
   * for actual line endings, then add snapped UTF-16 columns before slicing.
   */
  textBetween(start: Caret, end: Caret): string {
    const whole = this.text();
    // One encode for both ends. A line start always falls on a character boundary, whatever
    // the line ending is, so decoding the prefix up to one is lossless.
    const bytes = new TextEncoder().encode(whole);
    const charOffset = ({ line, column }: Caret): number => {
      const lineStart = this.#byteOffset({ line, column: 0 });
      const at = snapColumn(this.lineText(line), column);
      return new TextDecoder().decode(bytes.subarray(0, lineStart)).length + at;
    };
    return whole.slice(charOffset(start), charOffset(end));
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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Clamp the column to the text and move it backward to the start of a character if it splits
 * a surrogate pair.
 */
function snapColumn(text: string, column: number): number {
  const at = Math.min(Math.max(0, column), text.length);
  return isLowSurrogate(text.charCodeAt(at)) && isHighSurrogate(text.charCodeAt(at - 1))
    ? at - 1
    : at;
}
