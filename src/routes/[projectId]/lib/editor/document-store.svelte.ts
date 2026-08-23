import { history, position, query, rendering, scan, store } from "@kozmof/reed";

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
 * How long consecutive edits keep joining one undo entry.
 *
 * Off in Reed by default, which makes every keystroke its own entry and turns undoing a
 * mistyped word into holding the key down. With a window, a run of typing comes back in
 * one press and the caret returns to where the run started.
 *
 * Reed only joins edits that continue each other, so this does not group more than it
 * should: a pause longer than the window starts a new entry, and so does an edit somewhere
 * else in the document or an edit of a different kind — typing, then deleting, is always
 * two. 300ms is short enough that the boundaries land where a typist pauses to think,
 * which is where an undo boundary is wanted anyway.
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
 * One open file, as the editor holds it.
 *
 * Wraps a Reed document store, which is shaped for React's `useSyncExternalStore`
 * (`subscribe` plus `getSnapshot`) rather than for runes. The bridge is one `$state.raw`
 * box refreshed from the subscription: **raw** because a Reed state is immutable and
 * compared by reference, so wrapping it in a deep proxy would cost a traversal of the whole
 * document on every edit to observe changes that never happen in place.
 *
 * Coordinates on this class are `(line, column)` in characters, which is what the render
 * layer and the key handling both work in. Reed positions are byte offsets; the conversion
 * happens here and nowhere else, so no caller has to remember which of the two it holds.
 */
export class EditorDocument {
  #store: ReedStore;
  #unsubscribe: (() => void) | null = null;

  /** The current Reed state. Replaced wholesale on every edit. */
  state = $state.raw<DocumentState>(undefined as unknown as DocumentState);

  /**
   * The revision the file was last read or saved at. What `dirty` is measured against, so
   * an edit and its undo leave the file reported as unmodified again.
   */
  savedRevision = $state(0);

  constructor(content: string) {
    this.#store = store.createDocumentStore({ content, undoGroupTimeout: UNDO_GROUP_MS });
    this.state = this.#store.getSnapshot();
    this.#unsubscribe = this.#store.subscribe(() => {
      this.state = this.#store.getSnapshot();
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
    return query.getLineCount(this.state) as unknown as number;
  }

  get canUndo(): boolean {
    return history.canUndo(this.state) as unknown as boolean;
  }

  get canRedo(): boolean {
    return history.canRedo(this.state) as unknown as boolean;
  }

  get dirty(): boolean {
    return this.state.revision !== this.savedRevision;
  }

  /** Marks the current revision as what is on disk. Called after a save. */
  markSaved(): void {
    this.savedRevision = this.state.revision;
  }

  /**
   * The lines a viewport needs, and nothing else. This is what keeps a large file cheap:
   * the DOM only ever holds the window, so cost follows the height of the panel rather
   * than the length of the document.
   */
  visibleLines(startLine: number, visibleLineCount: number, overscan = 4): VisibleLine[] {
    const result = rendering.getVisibleLines(this.state, {
      startLine: Math.max(0, startLine),
      visibleLineCount,
      overscan,
    }) as unknown as { lines: readonly VisibleLine[] };
    return result.lines.map(({ lineNumber, content }) => ({ lineNumber, content }));
  }

  /** One line's text, or `""` for a line that is out of range. */
  lineText(line: number): string {
    return (rendering.getLineContent(this.state, line) as unknown as string | null) ?? "";
  }

  /** The whole document. O(n) — for saving, not for drawing. */
  text(): string {
    return scan.getValue(this.state.pieceTable) as unknown as string;
  }

  /** Holds a caret inside the document, and inside the line it names. */
  clamp({ line, column }: Caret): Caret {
    const lastLine = Math.max(0, this.lineCount - 1);
    const safeLine = Math.min(Math.max(0, line), lastLine);
    return {
      line: safeLine,
      column: Math.min(Math.max(0, column), this.lineText(safeLine).length),
    };
  }

  #byteOffset({ line, column }: Caret): number {
    const offset = rendering.lineColumnToPosition(this.state, line, column) as unknown as
      | number
      | null;
    // A caret past the end of the document resolves to nothing; the end of the document is
    // the nearest position that exists, and is where a caret in that state belongs.
    return offset ?? this.state.pieceTable.totalLength;
  }

  #caretAt(byteOffset: number): Caret {
    const at = rendering.positionToLineColumn(
      this.state,
      byteOffset as never,
    ) as unknown as Caret | null;
    return at ?? { line: 0, column: 0 };
  }

  /**
   * Where the caret was when an edit was made, recorded on the action itself.
   *
   * This is what undo has to put the caret back to. Reed keeps the selection an action
   * carried in its history entry and restores it on the way back, so an edit dispatched
   * without one leaves nothing to return to and undo strands the caret wherever it
   * happens to be — which, for an edit made far up a long file, is nowhere near the text
   * that just changed.
   */
  #selectionAt(byteOffset: number) {
    const at = position.byteOffset(byteOffset);
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
   * Deletes `start`–`end`, and answers where the caret ends up.
   *
   * `caretBefore` is where the caret was when the key was pressed, which is not something
   * the range says: a backspace deletes what is behind a caret sitting at `end`, and a
   * forward delete takes what is in front of one sitting at `start`. It is what undo puts
   * the caret back to, so passing the wrong end of the range returns it a character away
   * from where the edit was made. Defaults to `start`, which is right for a deletion the
   * caret was already sitting at the front of.
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

  /** The text between two carets. O(n) in the span, so not for drawing. */
  textBetween(start: Caret, end: Caret): string {
    const whole = this.text();
    const from = charOffset(whole, start, this);
    const to = charOffset(whole, end, this);
    return whole.slice(from, to);
  }

  /** The caret this document's own selection points at, or null when it has none. */
  selectionCaret(): Caret | null {
    const head = query.getSelectionHead(this.state) as unknown as number | undefined | null;
    return head === undefined || head === null ? null : this.#caretAt(head);
  }

  /**
   * Steps back one edit and answers where the caret belongs: the position recorded with
   * the edit being undone. Null when there was nothing to undo, so a caller can leave the
   * caret where it is rather than move it somewhere nothing chose.
   */
  undo(): Caret | null {
    if (!this.canUndo) return null;
    this.#store.dispatch(store.DocumentActions.undo());
    return this.selectionCaret();
  }

  /** The counterpart to {@link undo}: forward one edit, and where that leaves the caret. */
  redo(): Caret | null {
    if (!this.canRedo) return null;
    this.#store.dispatch(store.DocumentActions.redo());
    return this.selectionCaret();
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A caret as an index into the whole document string, for the slicing helpers above. */
function charOffset(whole: string, caret: Caret, doc: EditorDocument): number {
  let offset = 0;
  for (let line = 0; line < caret.line; line++) offset += doc.lineText(line).length + 1;
  return offset + caret.column;
}
