import type { Caret, EditorDocument } from "./document-store.svelte.js";

/** What the surface's default key handling reads and changes. */
export type SurfaceKeyHost = {
  readonly doc: EditorDocument;
  caret: Caret;
  /** The other end of the selection, or null when there is none. */
  anchor: Caret | null;
  readonly readonly: boolean;
  /** Rows a Page Up or Page Down moves. */
  readonly pageRows: number;
  moveTo(next: Caret, extend: boolean): void;
  /** Move by drawn rows, keeping the column vertical moves aim for. */
  moveByRows(by: number, extend: boolean): void;
  collapse(): void;
  /** Delete the selection, answering whether there was one. */
  deleteSelection(): boolean;
  /** Replace the selection, if any, with `text`. */
  insertText(text: string): void;
};

/**
 * The editor surface's default key handling: undo and redo, select all, caret movement,
 * and typing. Run after the host has had its chance at the key, and outside composition.
 * Keys it does not handle, including clipboard accelerators and Ctrl+S, are left alone.
 */
export function handleSurfaceKey(event: KeyboardEvent, host: SurfaceKeyHost): void {
  const { doc } = host;
  const extend = event.shiftKey;
  const accel = event.ctrlKey || event.metaKey;
  const lastLine = Math.max(0, doc.lineCount - 1);

  // Let the parent handle saving and closing.
  if (accel && (event.key === "s" || event.key === "S")) return;

  if (accel) {
    switch (event.key) {
      case "z":
      case "Z": {
        event.preventDefault();
        // Move the host.caret to the undone edit so the changed text stays visible.
        const to = event.shiftKey ? doc.redo() : doc.undo();
        host.collapse();
        host.caret = doc.clamp(to ?? host.caret);
        return;
      }
      case "y": {
        event.preventDefault();
        const to = doc.redo();
        host.collapse();
        host.caret = doc.clamp(to ?? host.caret);
        return;
      }
      case "a":
        event.preventDefault();
        host.anchor = { line: 0, column: 0 };
        host.caret = { line: lastLine, column: doc.lineText(lastLine).length };
        return;
      case "Home":
        event.preventDefault();
        host.moveTo({ line: 0, column: 0 }, extend);
        return;
      case "End":
        event.preventDefault();
        host.moveTo({ line: lastLine, column: doc.lineText(lastLine).length }, extend);
        return;
    }
    // Leave clipboard accelerators to the browser, which dispatches the handled clipboard
    // events.
    return;
  }

  switch (event.key) {
    case "ArrowLeft": {
      event.preventDefault();
      if (host.caret.column > 0)
        host.moveTo(
          { line: host.caret.line, column: doc.columnBefore(host.caret.line, host.caret.column) },
          extend,
        );
      else if (host.caret.line > 0)
        host.moveTo(
          { line: host.caret.line - 1, column: doc.lineText(host.caret.line - 1).length },
          extend,
        );
      return;
    }
    case "ArrowRight": {
      event.preventDefault();
      if (host.caret.column < doc.lineText(host.caret.line).length)
        host.moveTo(
          { line: host.caret.line, column: doc.columnAfter(host.caret.line, host.caret.column) },
          extend,
        );
      else if (host.caret.line < lastLine)
        host.moveTo({ line: host.caret.line + 1, column: 0 }, extend);
      return;
    }
    case "ArrowUp":
      event.preventDefault();
      host.moveByRows(-1, extend);
      return;
    case "ArrowDown":
      event.preventDefault();
      host.moveByRows(1, extend);
      return;
    case "PageUp":
      event.preventDefault();
      host.moveByRows(-host.pageRows, extend);
      return;
    case "PageDown":
      event.preventDefault();
      host.moveByRows(host.pageRows, extend);
      return;
    case "Home":
      event.preventDefault();
      host.moveTo({ line: host.caret.line, column: 0 }, extend);
      return;
    case "End":
      event.preventDefault();
      host.moveTo({ line: host.caret.line, column: doc.lineText(host.caret.line).length }, extend);
      return;
  }

  if (host.readonly) return;

  switch (event.key) {
    case "Enter":
      event.preventDefault();
      host.insertText("\n");
      return;
    case "Tab":
      event.preventDefault();
      host.insertText("  ");
      return;
    case "Backspace": {
      event.preventDefault();
      if (host.deleteSelection()) return;
      // Restore the host.caret to the deleted range's end when undoing Backspace.
      if (host.caret.column > 0)
        host.caret = doc.delete(
          { line: host.caret.line, column: doc.columnBefore(host.caret.line, host.caret.column) },
          host.caret,
          host.caret,
        );
      else if (host.caret.line > 0)
        host.caret = doc.delete(
          { line: host.caret.line - 1, column: doc.lineText(host.caret.line - 1).length },
          host.caret,
          host.caret,
        );
      return;
    }
    case "Delete": {
      event.preventDefault();
      if (host.deleteSelection()) return;
      const lineLength = doc.lineText(host.caret.line).length;
      if (host.caret.column < lineLength)
        host.caret = doc.delete(host.caret, {
          line: host.caret.line,
          column: doc.columnAfter(host.caret.line, host.caret.column),
        });
      else if (host.caret.line < lastLine)
        host.caret = doc.delete(host.caret, { line: host.caret.line + 1, column: 0 });
      return;
    }
  }

  // Handle a single printable code point. Leave unrecognized named keys unhandled.
  if ([...event.key].length === 1 && !event.altKey) {
    event.preventDefault();
    host.insertText(event.key);
  }
}
