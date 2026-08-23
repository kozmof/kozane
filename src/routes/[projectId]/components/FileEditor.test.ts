import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import FileEditor from "./FileEditor.svelte";
import { EditorSession } from "../lib/editor/editor-session.svelte.js";

const REF = { taskspaceId: "ts-1", taskspaceName: "demo", path: "notes.md" };

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function fetcherFor(responses: Response[]) {
  const queue = [...responses];
  const calls: { method: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return queue.shift() ?? new Response("{}", { status: 500 });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

async function mount(
  responses: Response[] = [ok({ path: REF.path, content: "hello\n", signature: "sig-1" })],
  props: Record<string, unknown> = {},
) {
  const { fetcher, calls } = fetcherFor(responses);
  const ctx = { fetcher, projectId: "p-1" };
  const session = new EditorSession();
  const onClose = vi.fn();
  render(FileEditor, { props: { session, ctx, onClose, ...props } });
  await session.open(ctx, REF);
  return { session, ctx, calls, onClose };
}

describe("FileEditor", () => {
  it("draws nothing until a file is opened", () => {
    const session = new EditorSession();
    render(FileEditor, {
      props: {
        session,
        ctx: { fetcher: vi.fn() as unknown as typeof fetch, projectId: "p-1" },
        onClose: vi.fn(),
      },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the taskspace, the path, and the text", async () => {
    await mount();
    expect(await screen.findByText("demo")).toBeInTheDocument();
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("shows the reason a file could not be opened", async () => {
    await mount([
      new Response(JSON.stringify({ message: "File is not UTF-8 text" }), { status: 415 }),
    ]);
    expect(await screen.findByRole("alert")).toHaveTextContent("File is not UTF-8 text");
  });

  it("keeps Save disabled until something is changed", async () => {
    const { session } = await mount();
    const save = await screen.findByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    session.doc!.insert({ line: 0, column: 0 }, "x");
    await waitFor(() => expect(save).toBeEnabled());
  });

  it("marks the file as unsaved once it is changed", async () => {
    const { session } = await mount();
    session.doc!.insert({ line: 0, column: 0 }, "x");
    expect(await screen.findByTitle("Unsaved changes")).toBeInTheDocument();
  });

  it("saves the text when Save is pressed", async () => {
    const { session, calls } = await mount([
      ok({ path: REF.path, content: "hello\n", signature: "sig-1" }),
      ok({ signature: "sig-2" }),
    ]);
    session.doc!.insert({ line: 0, column: 5 }, "!");

    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls[1]).toMatchObject({ method: "PUT" }));
    expect(calls[1].body).toMatchObject({ path: "notes.md", content: "hello!\n" });
  });

  it("offers to reload from disk when a save conflicts", async () => {
    const { session } = await mount([
      ok({ path: REF.path, content: "hello\n", signature: "sig-1" }),
      new Response(JSON.stringify({ message: "File changed on disk since it was opened" }), {
        status: 409,
      }),
      ok({ path: REF.path, content: "from disk\n", signature: "sig-9" }),
    ]);
    session.doc!.insert({ line: 0, column: 0 }, "x");

    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    const reload = await screen.findByRole("button", { name: "Reload from disk" });

    await userEvent.click(reload);
    await waitFor(() => expect(screen.getByText("from disk")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Reload from disk" })).toBeNull();
  });

  it("closes on the Close button", async () => {
    const { session, onClose } = await mount();
    await userEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(session.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape when there is nothing unsaved", async () => {
    const { session } = await mount();
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(session.isOpen).toBe(false));
  });

  it("does not close on Escape over an unsaved change", async () => {
    const { session } = await mount();
    await screen.findByRole("dialog");
    session.doc!.insert({ line: 0, column: 0 }, "x");

    await userEvent.keyboard("{Escape}");
    expect(session.isOpen).toBe(true);
  });

  it("saves on the accelerator", async () => {
    const { session, calls } = await mount([
      ok({ path: REF.path, content: "hello\n", signature: "sig-1" }),
      ok({ signature: "sig-2" }),
    ]);
    await screen.findByRole("dialog");
    session.doc!.insert({ line: 0, column: 0 }, "x");

    await userEvent.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(calls[1]).toMatchObject({ method: "PUT" }));
  });

  it("offers no Save at all when the export is read-only", async () => {
    await mount([ok({ path: REF.path, content: "hello\n", signature: "sig-1" })], {
      readonly: true,
    });
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("reports the caret position", async () => {
    const { session } = await mount();
    expect(await screen.findByText("Ln 1, Col 1")).toBeInTheDocument();

    session.caret = { line: 1, column: 3 };
    expect(await screen.findByText("Ln 2, Col 4")).toBeInTheDocument();
  });

  it("shows no vim badge when vim mode is off", async () => {
    await mount();
    await screen.findByRole("dialog");
    expect(screen.queryByTestId("vim-mode")).toBeNull();
  });

  it("starts in normal mode when vim mode is on", async () => {
    await mount([ok({ path: REF.path, content: "hello\n", signature: "sig-1" })], {
      vimMode: true,
    });
    expect(await screen.findByTestId("vim-mode")).toHaveTextContent("NORMAL");
  });

  it("does not type into the file in vim normal mode", async () => {
    const { session } = await mount(
      [ok({ path: REF.path, content: "hello\n", signature: "sig-1" })],
      {
        vimMode: true,
      },
    );
    await screen.findByRole("dialog");
    (screen.getByTestId("editor-sink") as HTMLTextAreaElement).focus();

    await userEvent.keyboard("x");
    expect(session.doc!.text()).toBe("ello\n");
  });

  it("switches to insert mode on i and types from there", async () => {
    const { session } = await mount(
      [ok({ path: REF.path, content: "hello\n", signature: "sig-1" })],
      {
        vimMode: true,
      },
    );
    await screen.findByRole("dialog");
    (screen.getByTestId("editor-sink") as HTMLTextAreaElement).focus();

    await userEvent.keyboard("i");
    expect(await screen.findByTestId("vim-mode")).toHaveTextContent("INSERT");

    await userEvent.keyboard("Z");
    expect(session.doc!.text()).toBe("Zhello\n");
  });

  it("shows the pending key of a two-key sequence", async () => {
    await mount([ok({ path: REF.path, content: "a\nb\n", signature: "sig-1" })], { vimMode: true });
    await screen.findByRole("dialog");
    (screen.getByTestId("editor-sink") as HTMLTextAreaElement).focus();

    await userEvent.keyboard("d");
    expect(await screen.findByText("d_")).toBeInTheDocument();
  });

  it("keeps Escape for leaving insert mode rather than closing the file", async () => {
    const { session } = await mount(
      [ok({ path: REF.path, content: "hello\n", signature: "sig-1" })],
      {
        vimMode: true,
      },
    );
    await screen.findByRole("dialog");
    (screen.getByTestId("editor-sink") as HTMLTextAreaElement).focus();

    await userEvent.keyboard("i");
    await userEvent.keyboard("{Escape}");

    expect(session.isOpen).toBe(true);
    expect(screen.getByTestId("vim-mode")).toHaveTextContent("NORMAL");
  });
});

describe("FileEditor resizing", () => {
  /**
   * The splitter reports its own width, which is what the assertions read. jsdom drops CSS
   * `clamp()` from an inline style, so the rendered width is not observable here; the value
   * the splitter is set to is, and it is the thing under test.
   */
  async function splitter() {
    return screen.findByRole("separator", { name: "Resize editor" });
  }

  function widthOf(el: HTMLElement): number {
    return Number(el.getAttribute("aria-valuenow"));
  }

  it("offers a splitter on the left edge, reporting its width and floor", async () => {
    await mount();
    const bar = await splitter();
    expect(bar).toHaveAttribute("aria-orientation", "vertical");
    expect(bar).toHaveAttribute("aria-valuemin", "320");
    expect(widthOf(bar)).toBeGreaterThanOrEqual(320);
  });

  it("widens the panel when the edge is dragged left", async () => {
    await mount();
    const bar = await splitter();
    const before = widthOf(bar);

    await fireEvent.mouseDown(bar, { button: 0, clientX: 900 });
    await fireEvent.mouseMove(window, { clientX: 700 });
    await fireEvent.mouseUp(window);

    expect(widthOf(bar)).toBe(before + 200);
  });

  it("narrows the panel when the edge is dragged right", async () => {
    await mount();
    const bar = await splitter();

    // Widen first, so there is room to come back without meeting the floor.
    await fireEvent.mouseDown(bar, { button: 0, clientX: 900 });
    await fireEvent.mouseMove(window, { clientX: 600 });
    await fireEvent.mouseUp(window);
    const wide = widthOf(bar);

    await fireEvent.mouseDown(bar, { button: 0, clientX: 600 });
    await fireEvent.mouseMove(window, { clientX: 700 });
    await fireEvent.mouseUp(window);
    expect(widthOf(bar)).toBe(wide - 100);
  });

  it("stops resizing once the drag has finished", async () => {
    await mount();
    const bar = await splitter();

    await fireEvent.mouseDown(bar, { button: 0, clientX: 900 });
    await fireEvent.mouseMove(window, { clientX: 800 });
    await fireEvent.mouseUp(window);
    const settled = widthOf(bar);

    await fireEvent.mouseMove(window, { clientX: 400 });
    expect(widthOf(bar)).toBe(settled);
  });

  it("resizes from the keyboard, left widening and right narrowing", async () => {
    await mount();
    const bar = await splitter();
    const start = widthOf(bar);

    await fireEvent.keyDown(bar, { key: "ArrowLeft" });
    expect(widthOf(bar)).toBe(start + 16);

    await fireEvent.keyDown(bar, { key: "ArrowLeft" });
    expect(widthOf(bar)).toBe(start + 32);

    await fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(widthOf(bar)).toBe(start + 16);
  });

  it("never narrows below the floor", async () => {
    await mount();
    const bar = await splitter();
    for (let i = 0; i < 80; i++) await fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(widthOf(bar)).toBe(320);
  });

  it("leaves keys other than the arrows to the panel", async () => {
    const { session } = await mount();
    const bar = await splitter();
    await fireEvent.keyDown(bar, { key: "Escape" });
    // Escape still closes the file: the splitter claims the arrows and nothing else.
    await waitFor(() => expect(session.isOpen).toBe(false));
  });

  it("keeps the width across closing and reopening a file", async () => {
    const { session, ctx } = await mount();
    const bar = await splitter();
    await fireEvent.keyDown(bar, { key: "ArrowLeft" });
    const chosen = widthOf(bar);

    session.close();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await session.open(ctx, REF);
    const reopened = await splitter();
    expect(widthOf(reopened)).toBe(chosen);
  });
});

describe("FileEditor closing", () => {
  async function dirty() {
    const mounted = await mount();
    await screen.findByRole("dialog");
    mounted.session.doc!.insert({ line: 0, column: 0 }, "x");
    await waitFor(() => expect(screen.getByTitle("Unsaved changes")).toBeInTheDocument());
    return mounted;
  }

  it("closes a clean file on a press outside the panel", async () => {
    const { session } = await mount();
    await screen.findByRole("dialog");

    await fireEvent.mouseDown(document.body);
    await waitFor(() => expect(session.isOpen).toBe(false));
  });

  it("stays open for a press inside the panel", async () => {
    const { session } = await mount();
    const dialog = await screen.findByRole("dialog");

    await fireEvent.mouseDown(dialog);
    await fireEvent.mouseDown(screen.getByTestId("editor-sink"));
    expect(session.isOpen).toBe(true);
  });

  it("stops listening once the file is closed", async () => {
    const { session, onClose } = await mount();
    await screen.findByRole("dialog");
    await fireEvent.mouseDown(document.body);
    await waitFor(() => expect(session.isOpen).toBe(false));

    onClose.mockClear();
    await fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks before discarding unsaved changes on a press outside", async () => {
    const { session } = await dirty();

    await fireEvent.mouseDown(document.body);
    expect(session.isOpen).toBe(true);
    expect(await screen.findByText("This file has unsaved changes.")).toBeInTheDocument();
  });

  it("asks before discarding unsaved changes on Escape", async () => {
    const { session } = await dirty();

    await userEvent.keyboard("{Escape}");
    expect(session.isOpen).toBe(true);
    expect(await screen.findByText("This file has unsaved changes.")).toBeInTheDocument();
  });

  it("closes when the discard is confirmed", async () => {
    const { session } = await dirty();
    await fireEvent.mouseDown(document.body);

    await userEvent.click(await screen.findByRole("button", { name: "Discard and close" }));
    expect(session.isOpen).toBe(false);
  });

  it("goes back to editing when the question is declined", async () => {
    const { session } = await dirty();
    await fireEvent.mouseDown(document.body);

    await userEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(session.isOpen).toBe(true);
    expect(screen.queryByText("This file has unsaved changes.")).toBeNull();
  });

  it("backs out of the question on a second Escape rather than closing", async () => {
    const { session } = await dirty();
    await userEvent.keyboard("{Escape}");
    await screen.findByText("This file has unsaved changes.");

    await userEvent.keyboard("{Escape}");
    expect(session.isOpen).toBe(true);
    expect(screen.queryByText("This file has unsaved changes.")).toBeNull();
  });

  it("asks when the header Close is pressed over unsaved changes", async () => {
    const { session } = await dirty();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(session.isOpen).toBe(true);
    expect(await screen.findByText("This file has unsaved changes.")).toBeInTheDocument();
  });

  it("drops the question when a different file is opened", async () => {
    const { session, ctx } = await dirty();
    await userEvent.keyboard("{Escape}");
    await screen.findByText("This file has unsaved changes.");

    await session.open(ctx, { ...REF, path: "other.md" });
    await waitFor(() => expect(screen.queryByText("This file has unsaved changes.")).toBeNull());
  });
});
