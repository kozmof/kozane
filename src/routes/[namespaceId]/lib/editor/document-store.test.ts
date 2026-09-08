import { describe, it, expect, afterEach, vi } from "vitest";
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

  // The span used to be measured by counting characters and adding one per line for the
  // newline between them, which is a claim about the file's line endings. On CRLF it ran a
  // character short for every line the span crossed, so a copy out of the editor came back
  // shifted — and further with every line.
  it("reads across CRLF line endings without drifting", () => {
    const d = doc("one\r\ntwo\r\nthree\r\n");
    expect(d.textBetween({ line: 1, column: 0 }, { line: 1, column: 3 })).toBe("two");
    expect(d.textBetween({ line: 2, column: 0 }, { line: 2, column: 5 })).toBe("three");
    expect(d.textBetween({ line: 0, column: 1 }, { line: 1, column: 2 })).toBe("ne\r\ntw");
  });

  // A column counts UTF-16 code units, so an astral character takes two of them and the
  // span has to be cut in the same units the column is quoted in.
  it("reads a span measured past a multi-byte character", () => {
    const d = doc("🗂 files\nplain\n");
    expect(d.lineText(0).length).toBe(8);
    expect(d.textBetween({ line: 0, column: 0 }, { line: 0, column: 2 })).toBe("🗂");
    expect(d.textBetween({ line: 0, column: 3 }, { line: 0, column: 8 })).toBe("files");
    // And across a line, where the offset of the second caret depends on the first line's
    // length in those same units.
    expect(d.textBetween({ line: 0, column: 3 }, { line: 1, column: 5 })).toBe("files\nplain");
  });

  it("reads nothing between a caret and itself", () => {
    const d = doc("one\ntwo\n");
    expect(d.textBetween({ line: 1, column: 1 }, { line: 1, column: 1 })).toBe("");
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

  it("returns the caret to the end of a backspaced range, where the caret actually was", () => {
    // A backspace at column 5 deletes [4,5) — the caret was at 5, not at 4, and 5 is where
    // undo has to put it back. Recording the range's start instead left it a character
    // short of where the typing had got to.
    const d = doc("hello world\n");
    d.delete({ line: 0, column: 4 }, { line: 0, column: 5 }, { line: 0, column: 5 });
    expect(d.text()).toBe("hell world\n");
    expect(d.undo()).toEqual({ line: 0, column: 5 });
    expect(d.text()).toBe("hello world\n");
  });

  it("returns the caret to the start of a forward-deleted range", () => {
    // Delete takes what is in front of the caret, so the caret was at the start already.
    const d = doc("hello world\n");
    d.delete({ line: 0, column: 5 }, { line: 0, column: 6 }, { line: 0, column: 5 });
    expect(d.undo()).toEqual({ line: 0, column: 5 });
  });

  it("takes the range's start when no caret is named", () => {
    const d = doc("hello world\n");
    d.delete({ line: 0, column: 4 }, { line: 0, column: 5 });
    expect(d.undo()).toEqual({ line: 0, column: 4 });
  });

  it("returns the caret to the end a selection was dragged to", () => {
    const d = doc("hello world\n");
    // Dragged right to left, so the live caret is the start of the range.
    d.delete({ line: 0, column: 6 }, { line: 0, column: 11 }, { line: 0, column: 6 });
    expect(d.undo()).toEqual({ line: 0, column: 6 });

    const back = doc("hello world\n");
    // Dragged left to right, so the live caret is the end of it.
    back.delete({ line: 0, column: 6 }, { line: 0, column: 11 }, { line: 0, column: 11 });
    expect(back.undo()).toEqual({ line: 0, column: 11 });
  });

  it("still lands a redo at the deletion point rather than at the recorded caret", () => {
    const d = doc("hello world\n");
    d.delete({ line: 0, column: 4 }, { line: 0, column: 5 }, { line: 0, column: 5 });
    d.undo();
    expect(d.redo()).toEqual({ line: 0, column: 4 });
    expect(d.text()).toBe("hell world\n");
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
    // Two edits in different places, so each is its own entry: consecutive edits in one
    // place are joined into a single undo, which the grouping tests below cover.
    const d = doc("a\nb\n");
    d.insert({ line: 0, column: 1 }, "X");
    d.insert({ line: 1, column: 1 }, "Y");
    expect(d.text()).toBe("aX\nbY\n");

    expect(d.undo()).toEqual({ line: 1, column: 1 });
    expect(d.undo()).toEqual({ line: 0, column: 1 });
    expect(d.text()).toBe("a\nb\n");
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

  describe("grouping consecutive edits into one undo", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Grouping keys off the wall clock, so the clock is what a test has to drive. */
    function atTime(ms: number): void {
      vi.setSystemTime(new Date(ms));
    }

    it("takes back a run of typing in one undo", () => {
      vi.useFakeTimers();
      atTime(1000);

      const d = doc("");
      let at = { line: 0, column: 0 };
      for (const ch of "hello") at = d.insert(at, ch);
      expect(d.text()).toBe("hello");

      // One press, not five: without a grouping window every keystroke is its own entry.
      d.undo();
      expect(d.text()).toBe("");
    });

    it("puts the caret back at the start of the run it took back", () => {
      vi.useFakeTimers();
      atTime(1000);

      const d = doc("say \n");
      let at = { line: 0, column: 4 };
      for (const ch of "hello") at = d.insert(at, ch);
      expect(d.text()).toBe("say hello\n");

      expect(d.undo()).toEqual({ line: 0, column: 4 });
      expect(d.text()).toBe("say \n");
    });

    it("starts a new entry after a pause longer than the window", () => {
      vi.useFakeTimers();
      atTime(1000);

      const d = doc("");
      let at = d.insert({ line: 0, column: 0 }, "a");
      at = d.insert(at, "b");

      // Long enough to fall outside the window, so the next character stands alone.
      atTime(5000);
      d.insert(at, "c");
      expect(d.text()).toBe("abc");

      d.undo();
      expect(d.text()).toBe("ab");
      d.undo();
      expect(d.text()).toBe("");
    });

    it("does not group edits made in different places", () => {
      vi.useFakeTimers();
      atTime(1000);

      const d = doc("one\ntwo\n");
      d.insert({ line: 0, column: 3 }, "!");
      d.insert({ line: 1, column: 3 }, "?");
      expect(d.text()).toBe("one!\ntwo?\n");

      // Two entries even inside the window: a jump elsewhere ends the run.
      d.undo();
      expect(d.text()).toBe("one!\ntwo\n");
    });

    it("does not group a delete with the typing before it", () => {
      vi.useFakeTimers();
      atTime(1000);

      const d = doc("");
      const at = d.insert({ line: 0, column: 0 }, "ab");
      d.delete({ line: 0, column: 0 }, at);
      expect(d.text()).toBe("");

      d.undo();
      expect(d.text()).toBe("ab");
    });
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

  describe("carets on characters wider than one column", () => {
    // "a😀b": the emoji is one character and two columns, so column 2 names its second
    // half. Reed refuses an edit at a byte offset inside a code point, and a line sliced
    // there for rendering comes back with a replacement character.
    const line = "a😀b\n";

    it("pulls a caret inside a character back to its start", () => {
      const d = doc(line);
      expect(d.clamp({ line: 0, column: 2 })).toEqual({ line: 0, column: 1 });
      expect(d.clamp({ line: 0, column: 1 })).toEqual({ line: 0, column: 1 });
      expect(d.clamp({ line: 0, column: 3 })).toEqual({ line: 0, column: 3 });
    });

    it("steps forward over a whole character", () => {
      const d = doc(line);
      expect(d.columnAfter(0, 0)).toBe(1);
      expect(d.columnAfter(0, 1)).toBe(3);
      expect(d.columnAfter(0, 3)).toBe(4);
      expect(d.columnAfter(0, 4)).toBe(4);
    });

    it("steps back over a whole character", () => {
      const d = doc(line);
      expect(d.columnBefore(0, 4)).toBe(3);
      expect(d.columnBefore(0, 3)).toBe(1);
      expect(d.columnBefore(0, 1)).toBe(0);
      expect(d.columnBefore(0, 0)).toBe(0);
    });

    it("steps off a column that landed inside a character", () => {
      const d = doc(line);
      expect(d.columnAfter(0, 2)).toBe(3);
      expect(d.columnBefore(0, 2)).toBe(0);
    });

    it("deletes the character a backspace steps back over, and not half of it", () => {
      const d = doc(line);
      const at = d.delete({ line: 0, column: d.columnBefore(0, 3) }, { line: 0, column: 3 });
      expect(d.text()).toBe("ab\n");
      expect(at).toEqual({ line: 0, column: 1 });
    });

    it("edits at a caret inside a character at that character's start", () => {
      const d = doc(line);
      // Reed resolves column 2 to the *end* of the emoji, so an insert that reached it
      // unsnapped would land after the emoji and not throw doing it. The text is what says
      // which of the two sides was taken; before Reed 3.1 the same column produced an
      // offset inside the code point and a RangeError out of the keystroke handler.
      expect(() => d.insert({ line: 0, column: 2 }, "X")).not.toThrow();
      expect(d.text()).toBe("aX😀b\n");
    });

    it("ends a deletion at the start of the character its column landed in", () => {
      const d = doc(line);
      d.delete({ line: 0, column: 0 }, { line: 0, column: 2 });
      // "😀b\n", not "b\n": snapping the end column forward would take the emoji with it.
      expect(d.text()).toBe("😀b\n");
    });

    it("keeps a range that starts inside a character covering that character", () => {
      const d = doc(line);
      // Reed resolves column 2 and column 3 alike to the emoji's end, so a range built from
      // the pair unsnapped is empty and the edit silently does nothing at all. Snapping the
      // leading side backward — what Reed's own docs ask a caret UI to do — is what leaves
      // this a deletion of the emoji rather than a no-op.
      d.delete({ line: 0, column: 2 }, { line: 0, column: 3 });
      expect(d.text()).toBe("ab\n");
    });

    it("replaces a character named by a range that starts inside it", () => {
      const d = doc(line);
      d.replace({ line: 0, column: 2 }, { line: 0, column: 3 }, "Z");
      expect(d.text()).toBe("aZb\n");
    });

    it("reads a span whose ends were named inside a character", () => {
      const d = doc(line);
      expect(d.textBetween({ line: 0, column: 0 }, { line: 0, column: 2 })).toBe("a");
    });
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
