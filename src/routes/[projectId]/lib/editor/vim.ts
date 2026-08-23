import type { Caret, EditorDocument } from "./document-store.svelte.js";

export type VimMode = "normal" | "insert";

export type VimState = {
  mode: VimMode;
  /** The first key of a two-key sequence — `g` of `gg`, `d` of `dd` — or null. */
  pending: string | null;
};

export type VimResult = {
  vim: VimState;
  caret: Caret;
  anchor: Caret | null;
};

export function createVimState(): VimState {
  return { mode: "normal", pending: null };
}

/**
 * Normal mode sits the caret *on* a character rather than between two, so the last column
 * of a line is its last character and not the position after it. An empty line has the one
 * position, which is why the floor is zero rather than a negative.
 */
function clampNormal(doc: EditorDocument, { line, column }: Caret): Caret {
  const safeLine = Math.min(Math.max(0, line), Math.max(0, doc.lineCount - 1));
  const length = doc.lineText(safeLine).length;
  return { line: safeLine, column: Math.min(Math.max(0, column), Math.max(0, length - 1)) };
}

/** The column after the last character, which is where insert mode may sit. */
function endOfLine(doc: EditorDocument, line: number): Caret {
  return { line, column: doc.lineText(line).length };
}

function firstNonBlank(doc: EditorDocument, line: number): Caret {
  const text = doc.lineText(line);
  const found = text.search(/\S/);
  return { line, column: found < 0 ? 0 : found };
}

const WORD = /\S/;

/** `w` — to the start of the next word. */
function wordForward(doc: EditorDocument, from: Caret): Caret {
  let { line, column } = from;
  let text = doc.lineText(line);

  // Off the current word, then over the whitespace after it, wrapping to the next line
  // when either runs off the end.
  while (column < text.length && WORD.test(text[column])) column++;
  while (true) {
    if (column >= text.length) {
      if (line >= doc.lineCount - 1) return clampNormal(doc, { line, column });
      line++;
      text = doc.lineText(line);
      column = 0;
      // A blank line is a word for `w`, which is what makes it a way through a paragraph
      // break rather than something that skips over one.
      if (text.length === 0) return { line, column: 0 };
      continue;
    }
    if (WORD.test(text[column])) return { line, column };
    column++;
  }
}

/** `b` — back to the start of the word before. */
function wordBackward(doc: EditorDocument, from: Caret): Caret {
  let { line, column } = from;
  let text = doc.lineText(line);

  while (true) {
    column--;
    if (column < 0) {
      if (line <= 0) return { line: 0, column: 0 };
      line--;
      text = doc.lineText(line);
      column = text.length - 1;
      if (text.length === 0) return { line, column: 0 };
      if (column < 0) continue;
    }
    if (column >= 0 && WORD.test(text[column])) break;
  }

  while (column > 0 && WORD.test(text[column - 1])) column--;
  return { line, column };
}

/** `e` — forward to the end of the current or next word. */
function wordEnd(doc: EditorDocument, from: Caret): Caret {
  let { line, column } = from;
  let text = doc.lineText(line);

  while (true) {
    column++;
    if (column >= text.length) {
      if (line >= doc.lineCount - 1) return clampNormal(doc, { line, column });
      line++;
      text = doc.lineText(line);
      column = -1;
      continue;
    }
    if (WORD.test(text[column])) break;
  }

  while (column + 1 < text.length && WORD.test(text[column + 1])) column++;
  return { line, column };
}

/** `caretBefore` is where the caret sat when `dd` was pressed, which is where undo returns it. */
function deleteLine(doc: EditorDocument, line: number, caretBefore: Caret): Caret {
  const lastLine = doc.lineCount - 1;
  if (line < lastLine) doc.delete({ line, column: 0 }, { line: line + 1, column: 0 }, caretBefore);
  else if (line > 0) doc.delete(endOfLine(doc, line - 1), endOfLine(doc, line), caretBefore);
  else doc.delete({ line: 0, column: 0 }, endOfLine(doc, 0), caretBefore);
  return clampNormal(doc, { line: Math.min(line, Math.max(0, doc.lineCount - 1)), column: 0 });
}

/**
 * Vim's share of the keyboard, as a function of the state and the key.
 *
 * Returns null when the key is not vim's, and the surface's own handling runs instead —
 * which is the whole of insert mode apart from `Escape`. Everything else in normal mode is
 * claimed, including keys with no binding, so that typing in normal mode cannot fall
 * through and insert the letter that was meant as a command.
 *
 * The document is edited through {@link EditorDocument} rather than returned as a list of
 * actions, which keeps this testable without a DOM while leaving one place that knows how
 * an edit is applied.
 */
export function handleVimKey(
  vim: VimState,
  event: KeyboardEvent,
  doc: EditorDocument,
  caret: Caret,
  readonly = false,
): VimResult | null {
  const accel = event.ctrlKey || event.metaKey;

  if (vim.mode === "insert") {
    if (event.key === "Escape") {
      // Leaving insert mode steps the caret back onto the last character typed, as vim does.
      return {
        vim: { mode: "normal", pending: null },
        caret: clampNormal(doc, { line: caret.line, column: caret.column - 1 }),
        anchor: null,
      };
    }
    return null;
  }

  // Normal mode. Accelerators stay with the browser and the overlay — Ctrl+S saves —
  // except the one vim defines.
  if (accel) {
    if (event.key === "r") {
      const to = doc.redo();
      return {
        vim: { ...vim, pending: null },
        caret: clampNormal(doc, to ?? caret),
        anchor: null,
      };
    }
    return null;
  }
  if (event.altKey) return null;

  const at = clampNormal(doc, caret);
  const line = at.line;
  const lastLine = Math.max(0, doc.lineCount - 1);
  const text = doc.lineText(line);

  const normal = (next: Caret, pending: string | null = null): VimResult => ({
    vim: { mode: "normal", pending },
    caret: clampNormal(doc, next),
    anchor: null,
  });
  const insertAt = (next: Caret): VimResult => ({
    vim: { mode: "insert", pending: null },
    caret: doc.clamp(next),
    anchor: null,
  });

  // Two-key sequences resolve before anything else, so the `g` of `gg` is not also a motion.
  if (vim.pending === "g") {
    if (event.key === "g") return normal({ line: 0, column: 0 });
    return normal(at);
  }
  if (vim.pending === "d") {
    if (event.key === "d") {
      if (readonly) return normal(at);
      return normal(deleteLine(doc, line, at));
    }
    return normal(at);
  }

  switch (event.key) {
    // Motions
    case "h":
    case "ArrowLeft":
      return normal({ line, column: at.column - 1 });
    case "l":
    case "ArrowRight":
      return normal({ line, column: at.column + 1 });
    case "j":
    case "ArrowDown":
      return normal({ line: Math.min(line + 1, lastLine), column: at.column });
    case "k":
    case "ArrowUp":
      return normal({ line: Math.max(line - 1, 0), column: at.column });
    case "0":
      return normal({ line, column: 0 });
    case "^":
      return normal(firstNonBlank(doc, line));
    case "$":
      return normal({ line, column: Math.max(0, text.length - 1) });
    case "G":
      return normal({ line: lastLine, column: 0 });
    case "w":
      return normal(wordForward(doc, at));
    case "b":
      return normal(wordBackward(doc, at));
    case "e":
      return normal(wordEnd(doc, at));

    // Pending sequences
    case "g":
      return normal(at, "g");
    case "d":
      return normal(at, "d");

    // Into insert mode
    case "i":
      return insertAt(at);
    case "a":
      return insertAt({ line, column: Math.min(at.column + 1, text.length) });
    case "I":
      return insertAt(firstNonBlank(doc, line));
    case "A":
      return insertAt(endOfLine(doc, line));
    case "o": {
      if (readonly) return normal(at);
      const landed = doc.insert(endOfLine(doc, line), "\n");
      return insertAt(landed);
    }
    case "O": {
      if (readonly) return normal(at);
      doc.insert({ line, column: 0 }, "\n");
      return insertAt({ line, column: 0 });
    }

    // Edits
    case "x": {
      if (readonly || text.length === 0) return normal(at);
      doc.delete(at, { line, column: at.column + 1 });
      return normal(at);
    }
    case "u":
      // `normal` clamps, so an undone edit at the end of a line lands on its last
      // character rather than after it, as vim does.
      return normal(doc.undo() ?? at);
  }

  // An unbound key in normal mode is still vim's: swallowing it is what keeps a stray
  // letter from being typed into the file.
  return normal(at, null);
}
