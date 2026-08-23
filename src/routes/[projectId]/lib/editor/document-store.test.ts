import { describe, it, expect } from "vitest";
import { EditorDocument, orderCarets, sameCaret } from "./document-store.svelte.js";

function doc(content: string): EditorDocument {
  return new EditorDocument(content);
}

describe("orderCarets", () => {
  it("puts the earlier line first", () => {
    const a = { line: 3, column: 0 };
    const b = { line: 1, column: 9 };
    expect(orderCarets(a, b)).toEqual({ start: b, end: a });
  });

  it("orders by column within one line", () => {
    const a = { line: 1, column: 7 };
    const b = { line: 1, column: 2 };
    expect(orderCarets(a, b)).toEqual({ start: b, end: a });
  });

  it("leaves an already-ordered pair alone", () => {
    const a = { line: 0, column: 0 };
    const b = { line: 0, column: 4 };
    expect(orderCarets(a, b)).toEqual({ start: a, end: b });
  });
});

describe("sameCaret", () => {
  it("compares both coordinates", () => {
    expect(sameCaret({ line: 1, column: 2 }, { line: 1, column: 2 })).toBe(true);
    expect(sameCaret({ line: 1, column: 2 }, { line: 1, column: 3 })).toBe(false);
    expect(sameCaret({ line: 1, column: 2 }, { line: 2, column: 2 })).toBe(false);
  });
});

describe("EditorDocument", () => {
  it("reports the text it was opened with", () => {
    expect(doc("hello\nworld\n").text()).toBe("hello\nworld\n");
  });

  it("counts a trailing newline as opening a further line", () => {
    expect(doc("a\nb\n").lineCount).toBe(3);
    expect(doc("a\nb").lineCount).toBe(2);
  });

  it("reads one line at a time", () => {
    const d = doc("first\nsecond\nthird\n");
    expect(d.lineText(0)).toBe("first");
    expect(d.lineText(1)).toBe("second");
    expect(d.lineText(9)).toBe("");
  });

  it("hands back only the lines a viewport asked for", () => {
    const d = doc(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
    const lines = d.visibleLines(10, 3, 0);
    expect(lines.map(({ lineNumber }) => lineNumber)).toEqual([10, 11, 12]);
    expect(lines[0].content).toBe("line 10");
  });

  it("widens the window by the overscan", () => {
    const d = doc(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
    const lines = d.visibleLines(10, 3, 2);
    expect(lines.map(({ lineNumber }) => lineNumber)).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it("inserts at a caret and reports where the caret lands", () => {
    const d = doc("hello\n");
    const at = d.insert({ line: 0, column: 5 }, " there");
    expect(d.text()).toBe("hello there\n");
    expect(at).toEqual({ line: 0, column: 11 });
  });

  it("inserts a newline and lands the caret on the next line", () => {
    const d = doc("ab\n");
    const at = d.insert({ line: 0, column: 1 }, "\n");
    expect(d.text()).toBe("a\nb\n");
    expect(at).toEqual({ line: 1, column: 0 });
  });

  it("counts columns in characters rather than bytes when inserting", () => {
    const d = doc("あい\n");
    const at = d.insert({ line: 0, column: 1 }, "X");
    expect(d.text()).toBe("あXい\n");
    expect(at).toEqual({ line: 0, column: 2 });
  });

  it("deletes a range and lands the caret at its start", () => {
    const d = doc("hello world\n");
    const at = d.delete({ line: 0, column: 5 }, { line: 0, column: 11 });
    expect(d.text()).toBe("hello\n");
    expect(at).toEqual({ line: 0, column: 5 });
  });

  it("deletes across lines", () => {
    const d = doc("one\ntwo\nthree\n");
    d.delete({ line: 0, column: 1 }, { line: 2, column: 2 });
    expect(d.text()).toBe("oree\n");
  });

  it("does nothing when a delete names an empty range", () => {
    const d = doc("hello\n");
    const before = d.state.revision;
    d.delete({ line: 0, column: 2 }, { line: 0, column: 2 });
    expect(d.text()).toBe("hello\n");
    expect(d.state.revision).toBe(before);
  });

  it("replaces a range in one entry that one undo takes back whole", () => {
    const d = doc("hello world\n");
    d.replace({ line: 0, column: 0 }, { line: 0, column: 5 }, "goodbye");
    expect(d.text()).toBe("goodbye world\n");
    d.undo();
    expect(d.text()).toBe("hello world\n");
  });

  it("reads the text between two carets", () => {
    const d = doc("one\ntwo\nthree\n");
    expect(d.textBetween({ line: 0, column: 1 }, { line: 1, column: 2 })).toBe("ne\ntw");
    expect(d.textBetween({ line: 1, column: 0 }, { line: 1, column: 3 })).toBe("two");
  });

  it("puts the caret back where an undone insert was made", () => {
    const d = doc("alpha\nbravo\ncharlie\n");
    d.insert({ line: 2, column: 7 }, "!!!");
    expect(d.text()).toBe("alpha\nbravo\ncharlie!!!\n");

    // The caret is far from the edit when the undo happens — up at the top of the file.
    expect(d.undo()).toEqual({ line: 2, column: 7 });
    expect(d.text()).toBe("alpha\nbravo\ncharlie\n");
  });

  it("puts the caret back where an undone delete was made", () => {
    const d = doc("alpha\nbravo\ncharlie\n");
    d.delete({ line: 1, column: 2 }, { line: 1, column: 5 });
    expect(d.text()).toBe("alpha\nbr\ncharlie\n");
    expect(d.undo()).toEqual({ line: 1, column: 2 });
  });

  it("puts the caret back where an undone replace was made", () => {
    const d = doc("alpha\nbravo\n");
    d.replace({ line: 1, column: 0 }, { line: 1, column: 5 }, "X");
    expect(d.undo()).toEqual({ line: 1, column: 0 });
  });

  it("moves the caret past the text a redo puts back", () => {
    const d = doc("alpha\n");
    d.insert({ line: 0, column: 5 }, "!!");
    d.undo();
    expect(d.redo()).toEqual({ line: 0, column: 7 });
    expect(d.text()).toBe("alpha!!\n");
  });

  it("reports the caret across a run of undos back to the start", () => {
    const d = doc("a\n");
    d.insert({ line: 0, column: 1 }, "b");
    d.insert({ line: 0, column: 2 }, "c");
    expect(d.text()).toBe("abc\n");

    expect(d.undo()).toEqual({ line: 0, column: 2 });
    expect(d.undo()).toEqual({ line: 0, column: 1 });
    expect(d.text()).toBe("a\n");
  });

  it("answers null rather than a position when there is nothing to undo or redo", () => {
    const d = doc("a\n");
    expect(d.undo()).toBeNull();
    expect(d.redo()).toBeNull();
  });

  it("tracks the caret through a multi-line edit", () => {
    const d = doc("one\ntwo\nthree\n");
    d.delete({ line: 0, column: 1 }, { line: 2, column: 2 });
    expect(d.text()).toBe("oree\n");
    expect(d.undo()).toEqual({ line: 0, column: 1 });
    expect(d.text()).toBe("one\ntwo\nthree\n");
  });

  it("walks back and forward through history", () => {
    const d = doc("a\n");
    expect(d.canUndo).toBe(false);
    d.insert({ line: 0, column: 1 }, "b");
    expect(d.text()).toBe("ab\n");
    expect(d.canUndo).toBe(true);

    d.undo();
    expect(d.text()).toBe("a\n");
    expect(d.canRedo).toBe(true);

    d.redo();
    expect(d.text()).toBe("ab\n");
  });

  it("ignores an undo with nothing behind it", () => {
    const d = doc("a\n");
    d.undo();
    expect(d.text()).toBe("a\n");
  });

  it("reports itself dirty from the first edit and clean again once saved", () => {
    const d = doc("a\n");
    expect(d.dirty).toBe(false);

    d.insert({ line: 0, column: 1 }, "b");
    expect(d.dirty).toBe(true);

    d.markSaved();
    expect(d.dirty).toBe(false);

    d.insert({ line: 0, column: 2 }, "c");
    expect(d.dirty).toBe(true);
  });

  it("clamps a caret into the document and into its line", () => {
    const d = doc("hello\nhi\n");
    expect(d.clamp({ line: 99, column: 0 })).toEqual({ line: 2, column: 0 });
    expect(d.clamp({ line: -3, column: -8 })).toEqual({ line: 0, column: 0 });
    expect(d.clamp({ line: 1, column: 99 })).toEqual({ line: 1, column: 2 });
  });

  it("tracks state through the subscription rather than being read by hand", () => {
    const d = doc("a\n");
    const first = d.state;
    d.insert({ line: 0, column: 1 }, "b");
    expect(d.state).not.toBe(first);
    expect(d.state.revision).toBeGreaterThan(first.revision);
  });

  it("can be disposed without throwing", () => {
    const d = doc("a\n");
    expect(() => d.dispose()).not.toThrow();
  });
});
