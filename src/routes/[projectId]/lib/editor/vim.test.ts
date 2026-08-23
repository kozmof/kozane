import { describe, it, expect } from "vitest";
import { EditorDocument } from "./document-store.svelte.js";
import { createVimState, handleVimKey, type VimResult, type VimState } from "./vim.js";

type Key = string | { key: string; ctrl?: boolean; meta?: boolean; alt?: boolean };

function keyEvent(key: Key): KeyboardEvent {
  const spec = typeof key === "string" ? { key } : key;
  return new KeyboardEvent("keydown", {
    key: spec.key,
    ctrlKey: spec.ctrl ?? false,
    metaKey: spec.meta ?? false,
    altKey: spec.alt ?? false,
  });
}

/**
 * Presses `keys` in order against a fresh document, and hands back where things ended up.
 * `null` in the results means the key was not vim's and the surface would have handled it.
 */
function press(content: string, keys: Key[], start = { line: 0, column: 0 }, readonly = false) {
  const doc = new EditorDocument(content);
  let vim: VimState = createVimState();
  let caret = start;
  let last: VimResult | null = null;

  for (const key of keys) {
    const result = handleVimKey(vim, keyEvent(key), doc, caret, readonly);
    last = result;
    if (!result) continue;
    vim = result.vim;
    caret = result.caret;
  }

  return { doc, vim, caret, last, text: doc.text() };
}

describe("createVimState", () => {
  it("starts in normal mode with nothing pending", () => {
    expect(createVimState()).toEqual({ mode: "normal", pending: null });
  });
});

describe("vim motions", () => {
  it("moves with hjkl", () => {
    expect(press("abc\ndef\n", ["l", "l"]).caret).toEqual({ line: 0, column: 2 });
    expect(press("abc\ndef\n", ["l", "l", "h"]).caret).toEqual({ line: 0, column: 1 });
    expect(press("abc\ndef\n", ["j"]).caret).toEqual({ line: 1, column: 0 });
    expect(press("abc\ndef\n", ["j", "k"]).caret).toEqual({ line: 0, column: 0 });
  });

  it("keeps the caret on a character rather than after the last one", () => {
    expect(press("abc\n", ["l", "l", "l", "l", "l"]).caret).toEqual({ line: 0, column: 2 });
  });

  it("does not walk off the top or the left", () => {
    expect(press("abc\n", ["h", "h"]).caret).toEqual({ line: 0, column: 0 });
    expect(press("abc\n", ["k"]).caret).toEqual({ line: 0, column: 0 });
  });

  it("moves to the ends of a line with 0 and $", () => {
    expect(press("hello\n", ["$"]).caret).toEqual({ line: 0, column: 4 });
    expect(press("hello\n", ["$", "0"]).caret).toEqual({ line: 0, column: 0 });
  });

  it("moves to the first non-blank with ^", () => {
    expect(press("   indented\n", ["^"]).caret).toEqual({ line: 0, column: 3 });
  });

  it("goes to the document ends with gg and G", () => {
    expect(press("a\nb\nc\n", ["G"]).caret.line).toBe(3);
    expect(press("a\nb\nc\n", ["G", "g", "g"]).caret).toEqual({ line: 0, column: 0 });
  });

  it("shows a pending g and clears it on a key that is not the second", () => {
    const first = press("a\nb\n", ["g"]);
    expect(first.vim.pending).toBe("g");
    expect(press("a\nb\n", ["g", "x"]).vim.pending).toBeNull();
  });

  it("moves forward a word with w", () => {
    expect(press("one two three\n", ["w"]).caret).toEqual({ line: 0, column: 4 });
    expect(press("one two three\n", ["w", "w"]).caret).toEqual({ line: 0, column: 8 });
  });

  it("carries w on to the next line", () => {
    expect(press("one\ntwo\n", ["w"]).caret).toEqual({ line: 1, column: 0 });
  });

  it("stops w on a blank line rather than skipping the paragraph break", () => {
    expect(press("one\n\ntwo\n", ["w"]).caret).toEqual({ line: 1, column: 0 });
  });

  it("moves back a word with b", () => {
    expect(press("one two three\n", ["$", "b"]).caret).toEqual({ line: 0, column: 8 });
    expect(press("one two\n", ["$", "b", "b"]).caret).toEqual({ line: 0, column: 0 });
  });

  it("carries b back to the previous line", () => {
    expect(press("one\ntwo\n", ["j", "b"]).caret).toEqual({ line: 0, column: 0 });
  });

  it("moves to the end of a word with e", () => {
    expect(press("one two\n", ["e"]).caret).toEqual({ line: 0, column: 2 });
    expect(press("one two\n", ["e", "e"]).caret).toEqual({ line: 0, column: 6 });
  });

  it("counts columns in characters, so a CJK line moves one cell at a time", () => {
    expect(press("あいう\n", ["l"]).caret).toEqual({ line: 0, column: 1 });
    expect(press("あいう\n", ["$"]).caret).toEqual({ line: 0, column: 2 });
  });
});

describe("vim mode transitions", () => {
  it("enters insert mode with i, at the caret", () => {
    const { vim, caret } = press("abc\n", ["l", "i"]);
    expect(vim.mode).toBe("insert");
    expect(caret).toEqual({ line: 0, column: 1 });
  });

  it("enters insert mode after the caret with a", () => {
    expect(press("abc\n", ["a"]).caret).toEqual({ line: 0, column: 1 });
  });

  it("enters insert mode at the first non-blank with I", () => {
    expect(press("  ab\n", ["$", "I"]).caret).toEqual({ line: 0, column: 2 });
  });

  it("enters insert mode past the last character with A", () => {
    expect(press("abc\n", ["A"]).caret).toEqual({ line: 0, column: 3 });
  });

  it("opens a line below with o", () => {
    const { text, caret, vim } = press("a\nb\n", ["o"]);
    expect(text).toBe("a\n\nb\n");
    expect(caret).toEqual({ line: 1, column: 0 });
    expect(vim.mode).toBe("insert");
  });

  it("opens a line above with O", () => {
    const { text, caret } = press("a\nb\n", ["j", "O"]);
    expect(text).toBe("a\n\nb\n");
    expect(caret).toEqual({ line: 1, column: 0 });
  });

  it("leaves insert mode on Escape and steps the caret back", () => {
    const { vim, caret } = press("abc\n", ["l", "l", "i", "Escape"]);
    expect(vim.mode).toBe("normal");
    expect(caret).toEqual({ line: 0, column: 1 });
  });

  it("hands every key but Escape to the surface while in insert mode", () => {
    const doc = new EditorDocument("abc\n");
    const insert: VimState = { mode: "insert", pending: null };
    expect(handleVimKey(insert, keyEvent("x"), doc, { line: 0, column: 0 })).toBeNull();
    expect(handleVimKey(insert, keyEvent("Escape"), doc, { line: 0, column: 0 })).not.toBeNull();
  });
});

describe("vim edits", () => {
  it("deletes the character under the caret with x", () => {
    expect(press("abc\n", ["x"]).text).toBe("bc\n");
    expect(press("abc\n", ["l", "x"]).text).toBe("ac\n");
  });

  it("does nothing on x at an empty line", () => {
    expect(press("\nabc\n", ["x"]).text).toBe("\nabc\n");
  });

  it("deletes a whole line with dd", () => {
    expect(press("one\ntwo\nthree\n", ["j", "d", "d"]).text).toBe("one\nthree\n");
  });

  it("deletes the first line with dd", () => {
    expect(press("one\ntwo\n", ["d", "d"]).text).toBe("two\n");
  });

  it("empties a one-line document with dd, taking the newline with the line", () => {
    expect(press("only\n", ["d", "d"]).text).toBe("");
  });

  it("deletes the last line of a document that does not end in a newline", () => {
    expect(press("one\ntwo", ["j", "d", "d"]).text).toBe("one");
  });

  it("clears a pending d on a key that is not the second", () => {
    const { text, vim } = press("one\ntwo\n", ["d", "x"]);
    expect(text).toBe("one\ntwo\n");
    expect(vim.pending).toBeNull();
  });

  it("undoes with u and redoes with Ctrl+r", () => {
    const doc = new EditorDocument("abc\n");
    let vim = createVimState();
    let caret = { line: 0, column: 0 };

    ({ vim, caret } = handleVimKey(vim, keyEvent("x"), doc, caret)!);
    expect(doc.text()).toBe("bc\n");

    ({ vim, caret } = handleVimKey(vim, keyEvent("u"), doc, caret)!);
    expect(doc.text()).toBe("abc\n");

    ({ vim, caret } = handleVimKey(vim, keyEvent({ key: "r", ctrl: true }), doc, caret)!);
    expect(doc.text()).toBe("bc\n");
  });
});

describe("vim and the rest of the keyboard", () => {
  it("swallows an unbound key rather than letting it be typed into the file", () => {
    const { text, last } = press("abc\n", ["z"]);
    expect(text).toBe("abc\n");
    expect(last).not.toBeNull();
  });

  it("leaves accelerators alone so the overlay can save", () => {
    const doc = new EditorDocument("abc\n");
    const vim = createVimState();
    expect(
      handleVimKey(vim, keyEvent({ key: "s", ctrl: true }), doc, { line: 0, column: 0 }),
    ).toBeNull();
    expect(
      handleVimKey(vim, keyEvent({ key: "s", meta: true }), doc, { line: 0, column: 0 }),
    ).toBeNull();
  });

  it("leaves Alt combinations alone", () => {
    const doc = new EditorDocument("abc\n");
    expect(
      handleVimKey(createVimState(), keyEvent({ key: "l", alt: true }), doc, {
        line: 0,
        column: 0,
      }),
    ).toBeNull();
  });

  it("moves with the arrow keys as well as with hjkl", () => {
    expect(press("abc\ndef\n", ["ArrowRight"]).caret).toEqual({ line: 0, column: 1 });
    expect(press("abc\ndef\n", ["ArrowDown"]).caret).toEqual({ line: 1, column: 0 });
  });
});

describe("vim when the file is read-only", () => {
  it("still moves", () => {
    expect(press("abc\n", ["l"], { line: 0, column: 0 }, true).caret).toEqual({
      line: 0,
      column: 1,
    });
  });

  it("changes nothing with x, dd, o, or O", () => {
    expect(press("one\ntwo\n", ["x"], { line: 0, column: 0 }, true).text).toBe("one\ntwo\n");
    expect(press("one\ntwo\n", ["d", "d"], { line: 0, column: 0 }, true).text).toBe("one\ntwo\n");
    expect(press("one\ntwo\n", ["o"], { line: 0, column: 0 }, true).text).toBe("one\ntwo\n");
    expect(press("one\ntwo\n", ["O"], { line: 0, column: 0 }, true).text).toBe("one\ntwo\n");
  });
});
