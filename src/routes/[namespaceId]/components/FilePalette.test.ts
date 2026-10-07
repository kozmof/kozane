import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import FilePalette from "./FilePalette.svelte";
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

/** Return `names` for directory listings. This helper does not handle POST requests. */
function fetcherFor(names: string[]) {
  return vi.fn(
    async () =>
      new Response(
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
      ),
  );
}

function makeProps(overrides: Record<string, unknown> = {}) {
  const fetcher = fetcherFor(["notes.md"]);
  return {
    scopes,
    scopeRels: [] as { scopeId: string; cardId: string }[],
    taskspaces: [taskspace({ id: "t1", name: "drafts", scopeId: "s1" })],
    selectedCards: new Set(["c1"]),
    tree: new TaskspaceTreeState(),
    ctx: { fetcher: fetcher as never, namespaceId: "namespace-1" },
    onOpenFile: vi.fn(),
    onLinkScope: vi.fn(),
    onCreate: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

const dialog = () => screen.getByRole("dialog", { name: "Edit a file" });

describe("FilePalette", () => {
  it("lists every scope, including ones with no taskspaces", () => {
    render(FilePalette, { props: makeProps() });
    screen.getByText("Writing");
    screen.getByText("Research");
    // s2 has none, and says so rather than looking like a scope that failed to load.
    expect(screen.getByText("No taskspaces in this scope.")).toBeTruthy();
  });

  it("expands every taskspace's tree by default", async () => {
    render(FilePalette, { props: makeProps() });

    const row = await screen.findByRole("button", { name: /drafts/ });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("notes.md")).toBeTruthy();
  });

  it("shows a taskspace's files without needing a click, and hands one back", async () => {
    const props = makeProps();
    render(FilePalette, { props });

    await userEvent.click(await screen.findByText("notes.md"));

    expect(props.onOpenFile).toHaveBeenCalledWith("t1", "drafts", "notes.md");
  });

  it("offers Link when the selection is not in the scope", async () => {
    const props = makeProps();
    render(FilePalette, { props });

    const [link] = screen.getAllByRole("button", { name: "Link" });
    await userEvent.click(link);

    expect(props.onLinkScope).toHaveBeenCalledWith("s1");
  });

  it("says Linked, with no button, once every selected card is in the scope", () => {
    render(FilePalette, { props: makeProps({ scopeRels: [{ scopeId: "s1", cardId: "c1" }] }) });

    expect(screen.getByText("Linked")).toBeTruthy();
    // Research still offers one, so this is about s1 rather than about the control missing.
    expect(screen.getAllByRole("button", { name: "Link" })).toHaveLength(1);
  });

  it("counts what is left when only some of the selection is linked", () => {
    render(FilePalette, {
      props: makeProps({
        selectedCards: new Set(["c1", "c2", "c3"]),
        scopeRels: [{ scopeId: "s1", cardId: "c1" }],
      }),
    });

    expect(screen.getByRole("button", { name: "Link 2 more" })).toBeTruthy();
  });

  it("folds a scope away and back", async () => {
    const props = makeProps();
    render(FilePalette, { props });
    const row = screen.getByRole("button", { name: /Writing/ });

    expect(row.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /drafts/ })).toBeNull();
  });

  it("creates only once all three names are given", async () => {
    const props = makeProps();
    render(FilePalette, { props });
    const create = screen.getByRole("button", { name: "Create" });

    expect(create.hasAttribute("disabled")).toBe(true);

    await userEvent.type(screen.getByLabelText("New scope name"), "work");
    await userEvent.type(screen.getByLabelText("New taskspace name"), "notes");
    expect(create.hasAttribute("disabled")).toBe(true);

    await userEvent.type(screen.getByLabelText("New file name"), "plan.md");
    await userEvent.click(create);

    expect(props.onCreate).toHaveBeenCalledWith({
      scope: "work",
      taskspace: "notes",
      file: "plan.md",
    });
  });

  it("moves to the next field on Enter, and only creates from the file field", async () => {
    const props = makeProps();
    render(FilePalette, { props });
    const scopeField = screen.getByLabelText("New scope name");
    const taskspaceField = screen.getByLabelText("New taskspace name");
    const fileField = screen.getByLabelText("New file name");

    await userEvent.type(scopeField, "work{Enter}");
    expect(taskspaceField).toHaveFocus();
    expect(props.onCreate).not.toHaveBeenCalled();

    await userEvent.type(taskspaceField, "notes{Enter}");
    expect(fileField).toHaveFocus();
    expect(props.onCreate).not.toHaveBeenCalled();

    await userEvent.type(fileField, "plan.md{Enter}");
    expect(props.onCreate).toHaveBeenCalledWith({
      scope: "work",
      taskspace: "notes",
      file: "plan.md",
    });
  });

  it("closes on Escape", async () => {
    const props = makeProps();
    render(FilePalette, { props });

    await fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("closes on a press on the backdrop but not inside the panel", async () => {
    const props = makeProps();
    const { container } = render(FilePalette, { props });

    await fireEvent.mouseDown(dialog());
    expect(props.onClose).not.toHaveBeenCalled();

    await fireEvent.mouseDown(container.querySelector('[role="presentation"]') as Element);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("keeps every key to itself, so the selection behind it is safe", async () => {
    const onWindowKey = vi.fn();
    globalThis.addEventListener("keydown", onWindowKey);
    render(FilePalette, { props: makeProps() });

    await fireEvent.keyDown(dialog(), { key: "Delete", bubbles: true });

    expect(onWindowKey).not.toHaveBeenCalled();
    globalThis.removeEventListener("keydown", onWindowKey);
  });

  it("offers neither linking nor creating in a read-only export", () => {
    render(FilePalette, { props: makeProps({ readonly: true }) });

    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New file in this taskspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New folder in this taskspace" })).toBeNull();
  });

  it("offers a new file or folder at an existing taskspace's root", () => {
    render(FilePalette, { props: makeProps() });

    expect(screen.getByRole("button", { name: "New file in this taskspace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New folder in this taskspace" })).toBeTruthy();
  });

  it("opens the taskspace it will create in, and shows the field there", async () => {
    const props = makeProps();
    render(FilePalette, { props });

    await userEvent.click(screen.getByRole("button", { name: "New file in this taskspace" }));

    expect(props.tree.creating).toEqual({ taskspaceId: "t1", path: "", kind: "file" });
    expect(props.tree.isExpanded("t1", "")).toBe(true);
    // Distinct from the footer's "File" field, which shares the same aria-label but not
    // this placeholder.
    expect(await screen.findByPlaceholderText("New file name")).toBeTruthy();
  });
});
