import { httpEditorContext } from "../../../test-utils/editor-context.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { tick } from "svelte";
import FileBrowser from "./FileBrowser.svelte";
import { TaskspaceTreeState } from "../lib/taskspace-tree.svelte.js";
import type { TaskspaceSummary } from "$lib/types";

const scopes = [
  { id: "s1", name: "Writing" },
  { id: "s2", name: "Research" },
];

function taskspace(overrides: Partial<TaskspaceSummary> & { id: string }): TaskspaceSummary {
  return {
    name: overrides.id,
    scopeId: "s1",
    path: overrides.id,
    pathKind: "workspace_relative",
    ...overrides,
  };
}

/** Answer directory listings with `names`, and every other request with `{}`. */
function fetcherFor(names: string[]) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      return new Response(JSON.stringify({ path: "renamed.md", kind: "file" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        path: "",
        entries: names.map((name) => ({
          name,
          kind: name.includes(".") ? "file" : "directory",
          size: null,
          modifiedAt: null,
        })),
        truncated: false,
      }),
      { status: 200 },
    );
  });
}

function makeProps(overrides: Record<string, unknown> = {}) {
  const fetcher = fetcherFor(["docs", "notes.md"]);
  return {
    scopes,
    taskspaces: [
      taskspace({ id: "t1", name: "drafts", scopeId: "s1" }),
      taskspace({ id: "t2", name: "papers", scopeId: "s2" }),
    ],
    tree: new TaskspaceTreeState(),
    ctx: httpEditorContext(fetcher as never, "namespace-1"),
    editorFile: null,
    actions: {
      createScope: vi.fn(async () => ({ id: "s3" })),
      renameScope: vi.fn(async () => null),
      removeScope: vi.fn(async () => null),
      createTaskspace: vi.fn(async () => ({ id: "t9" })),
      renameTaskspace: vi.fn(async () => null),
      deleteTaskspace: vi.fn(async () => ({ directory: "deleted" as const })),
    },
    onOpenFile: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

const column = (name: string) => within(screen.getByRole("region", { name }));

afterEach(() => vi.restoreAllMocks());

describe("FileBrowser", () => {
  it("shows scopes, the first scope's taskspaces, and that taskspace's files", async () => {
    render(FileBrowser, { props: makeProps() });

    column("Scopes").getByRole("option", { name: "Writing" });
    column("Taskspaces").getByRole("option", { name: "drafts" });
    expect(column("Taskspaces").queryByRole("option", { name: "papers" })).toBeNull();
    expect(await column("Files").findByText("notes.md")).toBeTruthy();
  });

  it("follows the chosen scope into the next column", async () => {
    render(FileBrowser, { props: makeProps() });

    await userEvent.click(column("Scopes").getByRole("option", { name: "Research" }));

    column("Taskspaces").getByRole("option", { name: "papers" });
    expect(column("Taskspaces").queryByRole("option", { name: "drafts" })).toBeNull();
  });

  it("starts on the taskspace of the file open in the editor", async () => {
    render(FileBrowser, {
      props: makeProps({
        editorFile: { taskspaceId: "t2", taskspaceName: "papers", path: "a.md" },
      }),
    });

    const row = column("Taskspaces").getByRole("option", { name: "papers" });
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("opens a clicked file", async () => {
    const props = makeProps();
    render(FileBrowser, { props });

    await userEvent.click(await column("Files").findByText("notes.md"));

    expect(props.onOpenFile).toHaveBeenCalledWith("t1", "drafts", "notes.md");
  });

  it("creates a scope from its column's + and selects it", async () => {
    const props = makeProps();
    render(FileBrowser, { props });

    await userEvent.click(screen.getByRole("button", { name: "New scope" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New scope name" }), "Ideas{Enter}");

    expect(props.actions.createScope).toHaveBeenCalledWith("Ideas");
  });

  it("creates a taskspace in the selected scope", async () => {
    const props = makeProps();
    render(FileBrowser, { props });

    await userEvent.click(screen.getByRole("button", { name: "New taskspace" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "New taskspace name" }),
      "plan{Enter}",
    );

    expect(props.actions.createTaskspace).toHaveBeenCalledWith("s1", "plan");
  });

  it("renames a scope from its pencil button and shows a refusal in place", async () => {
    const props = makeProps();
    props.actions.renameScope.mockResolvedValueOnce({ error: "Taken" } as never);
    render(FileBrowser, { props });

    await userEvent.click(screen.getByRole("button", { name: 'Rename "Writing"' }));
    const input = screen.getByRole("textbox", { name: "New name for Writing" });
    await userEvent.clear(input);
    await userEvent.type(input, "Prose{Enter}");

    expect(props.actions.renameScope).toHaveBeenCalledWith("s1", "Prose");
    expect((await screen.findByRole("alert")).textContent).toBe("Taken");
  });

  it("lets a name field submit again after its request throws", async () => {
    const props = makeProps();
    props.actions.renameScope.mockRejectedValueOnce(new Error("offline"));
    render(FileBrowser, { props });

    await userEvent.click(screen.getByRole("button", { name: 'Rename "Writing"' }));
    const input = screen.getByRole("textbox", { name: "New name for Writing" });
    await userEvent.clear(input);
    await userEvent.type(input, "Prose{Enter}");
    expect(await screen.findByRole("alert")).toBeTruthy();

    await userEvent.type(input, "{Enter}");
    expect(props.actions.renameScope).toHaveBeenCalledTimes(2);
  });

  it("keeps focus inside the dialog", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    render(FileBrowser, { props: makeProps() });

    const row = column("Scopes").getByRole("option", { name: "Writing" });
    row.focus();
    outside.focus();

    expect(screen.getByRole("dialog", { name: "Files" }).contains(document.activeElement)).toBe(
      true,
    );
    outside.remove();
  });

  it("will not delete a scope that still has taskspaces", () => {
    render(FileBrowser, { props: makeProps() });

    const button = screen.getByRole("button", { name: 'Delete "Writing"' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Delete its taskspaces first");
  });

  it("asks before deleting a taskspace and names the directory", async () => {
    const confirm = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const props = makeProps();
    render(FileBrowser, { props });

    await userEvent.click(screen.getByRole("button", { name: 'Delete "drafts"' }));

    expect(confirm.mock.calls[0][0]).toContain(
      "If Kozane created its directory t1, that directory and everything in it",
    );
    expect(props.actions.deleteTaskspace).toHaveBeenCalledWith("t1");
  });

  it("does nothing when the delete is not confirmed", async () => {
    vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    const props = makeProps();
    render(FileBrowser, { props });

    await userEvent.click(screen.getByRole("button", { name: 'Delete "drafts"' }));

    expect(props.actions.deleteTaskspace).not.toHaveBeenCalled();
  });

  it("deletes a folder after confirming, through the files endpoint", async () => {
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const fetcher = fetcherFor(["docs", "notes.md"]);
    const props = makeProps({ ctx: httpEditorContext(fetcher as never, "namespace-1") });
    render(FileBrowser, { props });

    await column("Files").findByText("docs");
    await userEvent.click(screen.getByRole("button", { name: 'Delete "docs"' }));

    const call = fetcher.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(call?.[0]).toContain("/taskspaces/t1/files?path=docs");
    expect(call?.[1]?.body).toBeUndefined();
  });

  it("protects the file open in the editor", async () => {
    const confirm = vi.spyOn(globalThis, "confirm");
    render(FileBrowser, {
      props: makeProps({
        editorFile: { taskspaceId: "t1", taskspaceName: "drafts", path: "notes.md" },
      }),
    });

    await column("Files").findByText("notes.md");
    await userEvent.click(screen.getByRole("button", { name: 'Delete "notes.md"' }));

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Close notes.md in the editor first.");
  });

  it("blocks renaming the taskspace whose file is open in the editor", async () => {
    render(FileBrowser, {
      props: makeProps({
        editorFile: { taskspaceId: "t1", taskspaceName: "drafts", path: "notes.md" },
      }),
    });

    await userEvent.click(screen.getByRole("button", { name: 'Rename "drafts"' }));

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Close notes.md in the editor first.");
  });

  it("keeps a file rename in its own taskspace after switching to another", async () => {
    let answerRename: (res: Response) => void = () => {};
    const listing = fetcherFor(["notes.md"]);
    const fetcher = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? new Promise<Response>((resolve) => (answerRename = resolve))
        : listing(url, init),
    );
    const props = makeProps({
      taskspaces: [
        taskspace({ id: "t1", name: "drafts", scopeId: "s1" }),
        taskspace({ id: "t3", name: "copies", scopeId: "s1" }),
      ],
      ctx: httpEditorContext(fetcher as never, "namespace-1"),
    });
    render(FileBrowser, { props });

    await column("Files").findByText("notes.md");
    await userEvent.click(screen.getByRole("button", { name: 'Rename "notes.md"' }));
    const input = screen.getByRole("textbox", { name: "New name for notes.md" });
    await userEvent.clear(input);
    await userEvent.type(input, "taken.md{Enter}");
    // Switch while the rename is still in flight, then let it fail.
    await userEvent.click(column("Taskspaces").getByRole("option", { name: "copies" }));
    await column("Files").findByText("notes.md");
    answerRename(new Response(JSON.stringify({ message: "Taken" }), { status: 409 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByRole("textbox", { name: "New name for notes.md" })).toBeNull();
    const patches = fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches.map(([u]) => u)).toEqual([expect.stringContaining("/taskspaces/t1/files")]);
  });

  it("hides every change control when read-only", async () => {
    render(FileBrowser, { props: makeProps({ readonly: true }) });

    await column("Files").findByText("notes.md");
    expect(screen.queryByRole("button", { name: "New scope" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rename / })).toBeNull();
  });

  it("moves between columns with the arrow keys", async () => {
    render(FileBrowser, { props: makeProps() });

    const writing = column("Scopes").getByRole("option", { name: "Writing" });
    writing.focus();
    await fireEvent.keyDown(writing, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Research");

    await fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe("papers");
  });

  it("steps over file rows that cannot be opened", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            path: "",
            entries: [
              { name: "docs", kind: "directory", size: null, modifiedAt: null },
              { name: "link", kind: "symlink", size: null, modifiedAt: null },
              { name: "notes.md", kind: "file", size: null, modifiedAt: null },
            ],
            truncated: false,
          }),
          { status: 200 },
        ),
    );
    render(FileBrowser, {
      props: makeProps({ ctx: httpEditorContext(fetcher as never, "namespace-1") }),
    });

    const docs = (await column("Files").findByText("docs")).closest("button")!;
    docs.focus();
    await fireEvent.keyDown(docs, { key: "ArrowDown" });

    expect(document.activeElement?.textContent).toContain("notes.md");
  });

  it("moves from a symlink's action button to the rows beside it, not to the ends", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            path: "",
            entries: ["a.md", "docs", "link", "notes.md", "z.md"].map((name) => ({
              name,
              kind: name === "link" ? "symlink" : name.includes(".") ? "file" : "directory",
              size: null,
              modifiedAt: null,
            })),
            truncated: false,
          }),
          { status: 200 },
        ),
    );
    render(FileBrowser, {
      props: makeProps({ ctx: httpEditorContext(fetcher as never, "namespace-1") }),
    });

    const remove = await screen.findByRole("button", { name: 'Delete "link"' });
    remove.focus();
    await fireEvent.keyDown(remove, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("notes.md");

    remove.focus();
    await fireEvent.keyDown(remove, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toContain("docs");
  });

  it("moves from a row's action button to the next row in the same column", async () => {
    render(FileBrowser, {
      props: makeProps({
        taskspaces: [
          taskspace({ id: "t1", name: "drafts" }),
          taskspace({ id: "t3", name: "outline" }),
        ],
      }),
    });

    const remove = screen.getByRole("button", { name: 'Delete "drafts"' });
    remove.focus();
    await fireEvent.keyDown(remove, { key: "ArrowDown" });

    expect(document.activeElement?.textContent).toBe("outline");
    const writing = column("Scopes").getByRole("option", { name: "Writing" });
    expect(writing.getAttribute("aria-selected")).toBe("true");
  });

  it("moves from a column header's button into that column", async () => {
    render(FileBrowser, { props: makeProps() });

    const add = screen.getByRole("button", { name: "New taskspace" });
    add.focus();
    await fireEvent.keyDown(add, { key: "ArrowDown" });

    expect(document.activeElement?.textContent).toBe("drafts");
  });

  it("says new taskspaces need a scope while No scope is chosen", async () => {
    render(FileBrowser, {
      props: makeProps({ taskspaces: [taskspace({ id: "t1", name: "loose", scopeId: null })] }),
    });

    await userEvent.click(column("Scopes").getByRole("option", { name: "No scope" }));

    const add = screen.getByRole("button", { name: "New taskspace" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe("New taskspaces need a scope");
  });

  it("keeps a message while focus moves across rows, and clears it on a click", async () => {
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const props = makeProps();
    vi.mocked(props.actions.deleteTaskspace).mockResolvedValue({ error: "Disk is busy" } as never);
    render(FileBrowser, { props });

    await userEvent.click(screen.getByRole("button", { name: 'Delete "drafts"' }));
    expect(screen.getByRole("alert").textContent).toBe("Disk is busy");

    column("Scopes").getByRole("option", { name: "Research" }).focus();
    await tick();
    expect(screen.getByRole("alert").textContent).toBe("Disk is busy");

    await userEvent.click(column("Scopes").getByRole("option", { name: "Writing" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves focus where it went when a name field loses it inside the modal", async () => {
    render(FileBrowser, { props: makeProps() });
    const dialog = screen.getByRole("dialog", { name: "Files" });

    await userEvent.click(screen.getByRole("button", { name: 'Rename "Writing"' }));
    // jsdom lets a focus() made during blur lose to the click's own focus, unlike browsers,
    // so watch for the call rather than where focus ends up.
    const pull = vi.spyOn(dialog, "focus");
    const research = column("Scopes").getByRole("option", { name: "Research" });
    await fireEvent.blur(screen.getByRole("textbox"), { relatedTarget: research });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(pull).not.toHaveBeenCalled();
  });

  it("takes focus back when a name field loses it to nothing", async () => {
    render(FileBrowser, { props: makeProps() });
    const dialog = screen.getByRole("dialog", { name: "Files" });

    await userEvent.click(screen.getByRole("button", { name: 'Rename "Writing"' }));
    const pull = vi.spyOn(dialog, "focus");
    await fireEvent.blur(screen.getByRole("textbox"), { relatedTarget: null });

    expect(pull).toHaveBeenCalled();
  });

  it("leaves F2 and Delete alone on a focused row", async () => {
    const confirm = vi.spyOn(globalThis, "confirm");
    const props = makeProps();
    render(FileBrowser, { props });

    const row = column("Taskspaces").getByRole("option", { name: "drafts" });
    row.focus();
    await fireEvent.keyDown(row, { key: "F2" });
    await fireEvent.keyDown(row, { key: "Delete" });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(props.actions.deleteTaskspace).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const props = makeProps();
    render(FileBrowser, { props });

    await fireEvent.keyDown(screen.getByRole("dialog", { name: "Files" }), { key: "Escape" });

    expect(props.onClose).toHaveBeenCalled();
  });
});
