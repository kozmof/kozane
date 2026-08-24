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
 *
 * Reed's own types are used as they come. Nothing here needs unwrapping: Reed 3 strips the
 * cost algebra at its `api/*` boundary, so `rendering` answers a plain `string | null` and
 * a plain `VisibleLinesResult` where Reed 2 answered those inside a `Costed<L, T>`. What
 * remains branded is `ByteOffset`, which is `number & Brand` and so already assignable to
 * `number`. This module once cast every one of these through `as unknown as`, which was
 * load-bearing against Reed 1 and became a way to not notice a signature changing
 * underneath.
 *
 * Every caret this class hands out or accepts sits on a UTF-8 code-point boundary, which
 * Reed 3 requires of the offsets an edit names and enforces by throwing `RangeError`. A
 * column counts UTF-16 code units, so the two disagree exactly on characters outside the
 * BMP — an emoji is one character, two columns wide — and a caret stepped one column at a
 * time lands between the halves of one. {@link clamp}, {@link columnBefore} and
 * {@link columnAfter} are what keep that from reaching a dispatch: before Reed 3 the same
 * caret inserted text into the middle of a code point and left mojibake behind.
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
   * The lines a viewport needs, and nothing else. This is what keeps a large file cheap:
   * the DOM only ever holds the window, so cost follows the height of the panel rather
   * than the length of the document.
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

  /** The whole document. O(n) — for saving, not for drawing. */
  text(): string {
    return scan.getValue(this.state.pieceTable);
  }

  /**
   * Holds a caret inside the document, inside the line it names, and on a character
   * boundary.
   *
   * The last of those is what a caret arriving from somewhere that counts columns needs:
   * a click resolved by measuring pixels, or a vertical move that carries a column onto a
   * line where it falls in the middle of an emoji. Such a column is pulled back to the
   * start of the character it landed inside, so the caret names a position that both the
   * renderer can slice a line at and Reed will accept an edit at.
   */
  clamp({ line, column }: Caret): Caret {
    const lastLine = Math.max(0, this.lineCount - 1);
    const safeLine = Math.min(Math.max(0, line), lastLine);
    return { line: safeLine, column: snapColumn(this.lineText(safeLine), column) };
  }

  /**
   * The column one character before `column`, for a leftward step or a backspace.
   *
   * One character, not one column: stepping by a column would put the caret between the
   * halves of a surrogate pair, and a backspace would take half an emoji.
   */
  columnBefore(line: number, column: number): number {
    const text = this.lineText(line);
    const at = snapColumn(text, column);
    if (at <= 0) return 0;
    return isLowSurrogate(text.charCodeAt(at - 1)) && isHighSurrogate(text.charCodeAt(at - 2))
      ? at - 2
      : at - 1;
  }

  /** The counterpart to {@link columnBefore}: one character forward. */
  columnAfter(line: number, column: number): number {
    const text = this.lineText(line);
    const at = snapColumn(text, column);
    if (at >= text.length) return text.length;
    return isHighSurrogate(text.charCodeAt(at)) && isLowSurrogate(text.charCodeAt(at + 1))
      ? at + 2
      : at + 1;
  }

  #byteOffset({ line, column }: Caret): number {
    // Snapped again here, where every caret this class turns into an offset passes, rather
    // than trusted from the caller: a column that names half a character converts to an
    // offset inside a code point, and Reed 3 throws a `RangeError` on an edit that carries
    // one. Thrown out of a keystroke handler that would take the editor down, so the last
    // word on the invariant belongs at the conversion rather than at each of its callers.
    const offset = rendering.lineColumnToPosition(
      this.state,
      line,
      snapColumn(this.lineText(line), column),
    );
    // A caret past the end of the document resolves to nothing; the end of the document is
    // the nearest position that exists, and is where a caret in that state belongs.
    return offset ?? this.state.pieceTable.totalLength;
  }

  #caretAt(byteOffset: number): Caret {
    // Through the branded constructor rather than `as never`: `position.byteOffset` is
    // what every other call here builds an offset with, and it is the one that would
    // object if Reed ever asked for something other than a byte offset.
    const at = rendering.positionToLineColumn(this.state, position.byteOffset(byteOffset));
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
  #selectionAt(byteOffset: number): [SelectionRange] {
    const at = position.byteOffset(byteOffset);
    // A tuple rather than an array: Reed 3 takes a non-empty selection, having found that
    // an empty one names no caret to come back to and so is never what a caller meant.
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

  /**
   * The text between two carets. O(n) in the document, so not for drawing.
   *
   * A caret is turned into an index by asking Reed where its *line* starts and adding the
   * column to that. The line start is the part that cannot be counted here: the previous
   * version summed the lines above and added one apiece for the separator between them,
   * which is a claim about the file's line endings that nothing in this class is in a
   * position to make. On CRLF it ran a character short for every line the span crossed, so
   * a copy out of the editor came back shifted, and further with every line.
   *
   * The column is added in the string's own units rather than resolved through Reed as
   * well, and deliberately: the slice is then a slice of the same string the columns were
   * measured against. It is snapped first, so a column naming half a character cuts at the
   * character instead — the alternative being a copied span that ends in half a surrogate
   * pair and pastes as `U+FFFD`.
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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * A column held inside `text` and moved off the inside of a character.
 *
 * Pulled back rather than forward, so the position names the start of the character it
 * landed in — the same character a click on that half of the pair was aimed at.
 */
function snapColumn(text: string, column: number): number {
  const at = Math.min(Math.max(0, column), text.length);
  return isLowSurrogate(text.charCodeAt(at)) && isHighSurrogate(text.charCodeAt(at - 1))
    ? at - 1
    : at;
}
