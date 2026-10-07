import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import EditorSurface from "./EditorSurface.svelte";
import { EditorDocument } from "../lib/editor/document-store.svelte.js";

/**
 * Test input handling in jsdom, which provides no layout measurements. Test geometry with
 * stub measurements and Playwright's real browser layout.
 */
function mount(content: string, props: Record<string, unknown> = {}) {
  const doc = new EditorDocument(content);
  render(EditorSurface, {
    props: { doc, caret: { line: 0, column: 0 }, anchor: null, ...props },
  });
  const sink = screen.getByTestId("editor-sink") as HTMLTextAreaElement;
  return { doc, sink };
}

describe("EditorSurface", () => {
  it("draws only the lines a viewport covers", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    mount(many);
    // Render only the visible window rather than all five thousand lines.
    expect(document.querySelectorAll("[style*='top']").length).toBeLessThan(200);
  });

  it("shows the text it was given", () => {
    mount("hello\nworld\n");
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("world")).toBeInTheDocument();
  });

  it("inserts a typed character at the caret", async () => {
    const { doc, sink } = mount("bc\n", { caret: { line: 0, column: 0 } });
    sink.focus();
    await userEvent.keyboard("a");
    expect(doc.text()).toBe("abc\n");
  });

  it("inserts a newline on Enter", async () => {
    const { doc, sink } = mount("ab\n", { caret: { line: 0, column: 1 } });
    sink.focus();
    await userEvent.keyboard("{Enter}");
    expect(doc.text()).toBe("a\nb\n");
  });

  it("inserts two spaces on Tab rather than moving focus", async () => {
    const { doc, sink } = mount("x\n", { caret: { line: 0, column: 0 } });
    sink.focus();
    await userEvent.keyboard("{Tab}");
    expect(doc.text()).toBe("  x\n");
  });

  it("deletes the character before the caret on Backspace", async () => {
    const { doc, sink } = mount("abc\n", { caret: { line: 0, column: 2 } });
    sink.focus();
    await userEvent.keyboard("{Backspace}");
    expect(doc.text()).toBe("ac\n");
  });

  it("joins two lines when Backspace is pressed at the start of one", async () => {
    const { doc, sink } = mount("ab\ncd\n", { caret: { line: 1, column: 0 } });
    sink.focus();
    await userEvent.keyboard("{Backspace}");
    expect(doc.text()).toBe("abcd\n");
  });

  it("deletes the character after the caret on Delete", async () => {
    const { doc, sink } = mount("abc\n", { caret: { line: 0, column: 1 } });
    sink.focus();
    await userEvent.keyboard("{Delete}");
    expect(doc.text()).toBe("ac\n");
  });

  it("does nothing on Backspace at the very start of the document", async () => {
    const { doc, sink } = mount("abc\n", { caret: { line: 0, column: 0 } });
    sink.focus();
    await userEvent.keyboard("{Backspace}");
    expect(doc.text()).toBe("abc\n");
  });

  it("walks the caret with the arrow keys", async () => {
    const { doc, sink } = mount("abc\n", { caret: { line: 0, column: 0 } });
    sink.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}X");
    expect(doc.text()).toBe("abXc\n");
  });

  it("walks the arrow keys over an emoji rather than into the middle of it", async () => {
    // Two columns, one character. A caret between them is a byte offset inside a code
    // point, which Reed refuses an edit at.
    const { doc, sink } = mount("a😀b\n", { caret: { line: 0, column: 0 } });
    sink.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}X");
    expect(doc.text()).toBe("a😀Xb\n");
  });

  it("takes a whole emoji on Backspace", async () => {
    const { doc, sink } = mount("a😀b\n", { caret: { line: 0, column: 3 } });
    sink.focus();
    await userEvent.keyboard("{Backspace}");
    expect(doc.text()).toBe("ab\n");
  });

  it("takes a whole emoji on Delete", async () => {
    const { doc, sink } = mount("a😀b\n", { caret: { line: 0, column: 1 } });
    sink.focus();
    await userEvent.keyboard("{Delete}");
    expect(doc.text()).toBe("ab\n");
  });

  it("undoes and redoes with the accelerator", async () => {
    const { doc, sink } = mount("a\n", { caret: { line: 0, column: 1 } });
    sink.focus();
    await userEvent.keyboard("b");
    expect(doc.text()).toBe("ab\n");

    await userEvent.keyboard("{Control>}z{/Control}");
    expect(doc.text()).toBe("a\n");

    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(doc.text()).toBe("ab\n");
  });

  it("moves the caret to the edit an undo takes back", async () => {
    const { doc, sink } = mount("alpha\nbravo\n", { caret: { line: 0, column: 5 } });
    sink.focus();
    await userEvent.keyboard("!");
    expect(doc.text()).toBe("alpha!\nbravo\n");

    // Walk the caret away from the edit, onto the line below.
    await userEvent.keyboard("{ArrowDown}{End}");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(doc.text()).toBe("alpha\nbravo\n");

    // Type to verify that undo returned the caret to the edit on the first line.
    await userEvent.keyboard("X");
    expect(doc.text()).toBe("alphaX\nbravo\n");
  });

  it("moves the caret past the text a redo puts back", async () => {
    const { doc, sink } = mount("alpha\n", { caret: { line: 0, column: 5 } });
    sink.focus();
    await userEvent.keyboard("!");
    await userEvent.keyboard("{Control>}z{/Control}");
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(doc.text()).toBe("alpha!\n");

    await userEvent.keyboard("X");
    expect(doc.text()).toBe("alpha!X\n");
  });

  it("returns the caret to where it was when a backspace is undone", async () => {
    const { doc, sink } = mount("hello world\n", { caret: { line: 0, column: 5 } });
    sink.focus();
    await userEvent.keyboard("{Backspace}");
    expect(doc.text()).toBe("hell world\n");

    await userEvent.keyboard("{Control>}z{/Control}");
    expect(doc.text()).toBe("hello world\n");

    // Type to verify that undo restored the caret to column 5, before the backspace.
    await userEvent.keyboard("X");
    expect(doc.text()).toBe("helloX world\n");
  });

  it("returns the caret to where it was when a forward delete is undone", async () => {
    const { doc, sink } = mount("hello world\n", { caret: { line: 0, column: 5 } });
    sink.focus();
    await userEvent.keyboard("{Delete}");
    expect(doc.text()).toBe("helloworld\n");

    await userEvent.keyboard("{Control>}z{/Control}");
    await userEvent.keyboard("X");
    expect(doc.text()).toBe("helloX world\n");
  });

  it("returns the caret to the end a selection was dragged to when its delete is undone", async () => {
    const { doc, sink } = mount("hello world\n", {
      caret: { line: 0, column: 11 },
      anchor: { line: 0, column: 6 },
    });
    sink.focus();
    await userEvent.keyboard("{Backspace}");
    expect(doc.text()).toBe("hello \n");

    await userEvent.keyboard("{Control>}z{/Control}");
    await userEvent.keyboard("X");
    expect(doc.text()).toBe("hello worldX\n");
  });

  it("leaves the caret alone when there is nothing to undo", async () => {
    const { doc, sink } = mount("alpha\n", { caret: { line: 0, column: 2 } });
    sink.focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    await userEvent.keyboard("X");
    expect(doc.text()).toBe("alXpha\n");
  });

  it("leaves the save accelerator for the overlay to handle", async () => {
    const { doc, sink } = mount("a\n", { caret: { line: 0, column: 1 } });
    sink.focus();
    await userEvent.keyboard("{Control>}s{/Control}");
    expect(doc.text()).toBe("a\n");
  });

  it("keeps a composition out of the document until it settles", async () => {
    const { doc, sink } = mount("\n", { caret: { line: 0, column: 0 } });
    sink.focus();

    await fireEvent.compositionStart(sink, { data: "" });
    await fireEvent.compositionUpdate(sink, { data: "にほn" });
    // Abandoning composition must leave no committed edit.
    expect(doc.text()).toBe("\n");

    await fireEvent.compositionEnd(sink, { data: "日本" });
    expect(doc.text()).toBe("日本\n");
  });

  it("commits a composition as one entry that one undo takes back whole", async () => {
    const { doc, sink } = mount("\n", { caret: { line: 0, column: 0 } });
    sink.focus();

    await fireEvent.compositionStart(sink, { data: "" });
    await fireEvent.compositionUpdate(sink, { data: "にほん" });
    await fireEvent.compositionEnd(sink, { data: "日本" });
    expect(doc.text()).toBe("日本\n");

    doc.undo();
    expect(doc.text()).toBe("\n");
  });

  it("draws the composing text where it will land", async () => {
    const { sink } = mount("\n", { caret: { line: 0, column: 0 } });
    sink.focus();
    await fireEvent.compositionStart(sink, { data: "" });
    await fireEvent.compositionUpdate(sink, { data: "にほn" });
    expect(document.querySelector("[data-preedit]")?.textContent).toBe("にほn");
  });

  it("drops the preedit once the composition ends", async () => {
    const { sink } = mount("\n", { caret: { line: 0, column: 0 } });
    sink.focus();
    await fireEvent.compositionStart(sink, { data: "" });
    await fireEvent.compositionUpdate(sink, { data: "にほn" });
    await fireEvent.compositionEnd(sink, { data: "日本" });
    expect(document.querySelector("[data-preedit]")).toBeNull();
  });

  it("ignores keys pressed while a composition is in progress", async () => {
    const { doc, sink } = mount("\n", { caret: { line: 0, column: 0 } });
    sink.focus();
    await fireEvent.compositionStart(sink, { data: "" });
    await fireEvent.keyDown(sink, { key: "a" });
    expect(doc.text()).toBe("\n");
  });

  it("inserts pasted text, normalising line endings", async () => {
    const { doc, sink } = mount("\n", { caret: { line: 0, column: 0 } });
    const clipboardData = { getData: () => "one\r\ntwo" };
    await fireEvent.paste(sink, { clipboardData });
    expect(doc.text()).toBe("one\ntwo\n");
  });

  it("writes the selection to the clipboard on copy", async () => {
    const { sink } = mount("hello world\n", {
      caret: { line: 0, column: 5 },
      anchor: { line: 0, column: 0 },
    });
    const setData = vi.fn();
    await fireEvent.copy(sink, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", "hello");
  });

  it("removes the selection on cut", async () => {
    const { doc, sink } = mount("hello world\n", {
      caret: { line: 0, column: 6 },
      anchor: { line: 0, column: 0 },
    });
    await fireEvent.cut(sink, { clipboardData: { setData: vi.fn() } });
    expect(doc.text()).toBe("world\n");
  });

  it("replaces the selection when a character is typed over it", async () => {
    const { doc, sink } = mount("hello\n", {
      caret: { line: 0, column: 5 },
      anchor: { line: 0, column: 0 },
    });
    sink.focus();
    await userEvent.keyboard("X");
    expect(doc.text()).toBe("X\n");
  });

  it("removes the selection on Backspace rather than one character", async () => {
    const { doc, sink } = mount("hello\n", {
      caret: { line: 0, column: 5 },
      anchor: { line: 0, column: 1 },
    });
    sink.focus();
    await userEvent.keyboard("{Backspace}");
    expect(doc.text()).toBe("h\n");
  });

  it("offers every key to the handler first, and skips its own on a claim", async () => {
    const onKeydown = vi.fn(() => true);
    const { doc, sink } = mount("a\n", { caret: { line: 0, column: 1 }, onKeydown });
    sink.focus();
    await userEvent.keyboard("b");
    expect(onKeydown).toHaveBeenCalled();
    expect(doc.text()).toBe("a\n");
  });

  it("falls through to its own handling when the handler declines", async () => {
    const onKeydown = vi.fn(() => false);
    const { doc, sink } = mount("a\n", { caret: { line: 0, column: 1 }, onKeydown });
    sink.focus();
    await userEvent.keyboard("b");
    expect(doc.text()).toBe("ab\n");
  });

  it("accepts no edit when readonly", async () => {
    const { doc, sink } = mount("a\n", { caret: { line: 0, column: 1 }, readonly: true });
    sink.focus();
    await userEvent.keyboard("b{Enter}{Backspace}");
    expect(doc.text()).toBe("a\n");
  });

  it("takes focus back when the text is clicked after being unfocused", async () => {
    const { sink } = mount("hello\nworld\n");
    sink.focus();
    sink.blur();
    expect(document.activeElement).not.toBe(sink);

    await fireEvent.mouseDown(screen.getByTestId("editor-surface"), {
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    expect(document.activeElement).toBe(sink);
  });

  it("suppresses the mousedown default that would blur the sink again", () => {
    // Check default prevention because jsdom does not simulate mousedown focus changes. In a
    // browser, the default action could clear the focus set by the handler.
    mount("hello\n");
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    screen.getByTestId("editor-surface").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a scrollbar drag to the browser", () => {
    mount("hello\n");
    const surface = screen.getByTestId("editor-surface");
    // Mock layout because jsdom reports zero-sized boxes. Scrollbar detection uses the
    // difference between border and client boxes.
    Object.defineProperty(surface, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(surface, "clientHeight", { value: 200, configurable: true });
    surface.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;

    const onBar = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 310, // past clientWidth: the vertical scrollbar
      clientY: 100,
    });
    surface.dispatchEvent(onBar);
    expect(onBar.defaultPrevented).toBe(false);

    // And a click on the text beside it is still the editor's.
    const onText = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    surface.dispatchEvent(onText);
    expect(onText.defaultPrevented).toBe(true);
  });

  it("leaves the view where a scroll put it rather than springing back to the caret", async () => {
    // Scroll when the caret moves, but do not reset manual scrolling when only the viewport
    // moves.
    mount(Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const surface = screen.getByTestId("editor-surface");
    // Mock dimensions and scroll positions because jsdom does not perform layout.
    let scrolled = 0;
    Object.defineProperty(surface, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(surface, "scrollTop", {
      get: () => scrolled,
      set: (value: number) => (scrolled = value),
      configurable: true,
    });

    scrolled = 4000;
    await fireEvent.scroll(surface);

    expect(scrolled).toBe(4000);
    // And the window that was drawn is the one the scroll asked for, not the caret's.
    expect(screen.getByText("line 200")).toBeInTheDocument();
  });

  it("lets keys through to whatever is hosting it, which is what owns Escape and saving", async () => {
    // Let keys reach `FileEditor`, which handles Ctrl+S, Escape, and propagation.
    const seen: string[] = [];
    const onWindowKey = (e: KeyboardEvent) => seen.push(e.key);
    globalThis.addEventListener("keydown", onWindowKey);
    try {
      const { sink } = mount("a\n", { caret: { line: 0, column: 1 } });
      sink.focus();
      await userEvent.keyboard("{Escape}");
      await userEvent.keyboard("{Control>}s{/Control}");
      expect(seen).toContain("Escape");
      expect(seen).toContain("s");
    } finally {
      globalThis.removeEventListener("keydown", onWindowKey);
    }
  });
});

describe("EditorSurface test hooks", () => {
  it("tags each drawn line with its line number", () => {
    const { doc } = mount("alpha\nbravo\ncharlie\n");
    const drawn = [...document.querySelectorAll("[data-line]")].map((el) =>
      Number(el.getAttribute("data-line")),
    );
    expect(drawn).toContain(0);
    expect(drawn).toContain(1);
    // Never render more lines than the document contains.
    expect(drawn.length).toBeLessThanOrEqual(doc.lineCount);
  });

  it("paints a selection as its own rectangles", () => {
    mount("hello world\n", {
      caret: { line: 0, column: 5 },
      anchor: { line: 0, column: 0 },
    });
    // One line selected, so one rectangle. The count is what the browser specs assert
    // against, and jsdom can at least confirm they are drawn at all.
    expect(document.querySelectorAll("[data-testid='editor-selection']")).toHaveLength(1);
  });

  it("paints nothing when there is no selection", () => {
    mount("hello world\n", { caret: { line: 0, column: 5 }, anchor: null });
    expect(document.querySelectorAll("[data-testid='editor-selection']")).toHaveLength(0);
  });
});
