import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import ScopeSidebar from "./ScopeSidebar.svelte";
import { TaskspaceTreeState } from "../lib/taskspace-tree.svelte.js";

const SCOPE = { id: "scope-1", name: "My Scope" };
const TASKSPACE = {
  id: "taskspace-1",
  name: "demo",
  scopeId: SCOPE.id,
  path: "demo",
  pathKind: "project_relative" as const,
};

function listingResponse(names: string[]): Response {
  return new Response(
    JSON.stringify({
      path: "",
      entries: names.map((name) => ({ name, kind: "file", size: null, modifiedAt: null })),
      truncated: false,
    }),
    { status: 200 },
  );
}

function mount(overrides: Record<string, unknown> = {}) {
  const fetcher = vi.fn(async () => listingResponse(["README.md"]));
  render(ScopeSidebar, {
    props: {
      visible: true,
      panelWidth: 240,
      scopes: [SCOPE],
      scopeRels: [],
      taskspaces: [TASKSPACE],
      taskspaceTree: new TaskspaceTreeState(),
      treeContext: { fetcher: fetcher as never, projectId: "project-1" },
      selectedCards: new Set<string>(),
      // The taskspace rows only exist under the open scope.
      activeScope: SCOPE.id,
      newScopeName: "",
      newWcName: "",
      onCreateScope: () => {},
      onDeleteScope: () => {},
      onAddToScope: () => {},
      onRemoveFromScope: () => {},
      onCreateTaskspace: () => {},
      ...overrides,
    },
  });
  return { fetcher };
}

describe("ScopeSidebar taskspaces", () => {
  it("opens a taskspace and lists what is in it", async () => {
    const { fetcher } = mount();

    await userEvent.click(screen.getByRole("button", { name: /demo/ }));

    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith("/project-1/api/taskspaces/taskspace-1/files");
  });

  it("offers a refresh only once the taskspace is open", async () => {
    const { fetcher } = mount();
    expect(screen.queryByTitle("Re-read this taskspace from disk")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /demo/ }));
    await screen.findByText("README.md");
    await userEvent.click(screen.getByTitle("Re-read this taskspace from disk"));

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("leaves the row unopenable in a read-only export", async () => {
    const { fetcher } = mount({ readonly: true });

    expect(screen.getByText("demo")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /demo/ })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  // The shape a real export actually ships for a taskspace with no directory to embed:
  // `path` is nulled (see `loadProjectSnapshot`) and `treeContext` carries no tree for it —
  // no id in `staticFiles` at all, the same as when the flag was never passed and there is
  // no `staticFiles` object to begin with. There is nothing to browse either way, so the
  // row does not render, the same as a taskspace with no directory has always been dropped
  // from this panel in the live app.
  it("does not render a taskspace row when the export has no path and no embedded tree for it", async () => {
    const { fetcher } = mount({
      readonly: true,
      taskspaces: [{ ...TASKSPACE, path: null }],
    });

    expect(screen.queryByText("demo")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("browses and opens a file from an embedded tree in a read-only export, without ever fetching", async () => {
    const fetcher = vi.fn(async () => listingResponse(["should-not-be-fetched"]));
    const onOpenFile = vi.fn();
    render(ScopeSidebar, {
      props: {
        visible: true,
        panelWidth: 240,
        scopes: [SCOPE],
        scopeRels: [],
        taskspaces: [{ ...TASKSPACE, path: null }],
        taskspaceTree: new TaskspaceTreeState(),
        treeContext: {
          fetcher: fetcher as never,
          projectId: "project-1",
          staticFiles: {
            [TASKSPACE.id]: {
              root: {
                kind: "directory",
                name: "",
                truncated: null,
                children: [{ kind: "file", name: "README.md", content: "hi\n", size: 3 }],
              },
            },
          },
        },
        selectedCards: new Set<string>(),
        activeScope: SCOPE.id,
        newScopeName: "",
        newWcName: "",
        onCreateScope: () => {},
        onDeleteScope: () => {},
        onAddToScope: () => {},
        onRemoveFromScope: () => {},
        onCreateTaskspace: () => {},
        onOpenFile,
        readonly: true,
      },
    });

    await userEvent.click(screen.getByRole("button", { name: /demo/ }));
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();

    // Save-adjacent affordances stay hidden even though browsing is live: there is no disk
    // behind a static export to re-read from.
    expect(screen.queryByTitle("Re-read this taskspace from disk")).toBeNull();

    await userEvent.click(screen.getByText("README.md"));
    expect(onOpenFile).toHaveBeenCalledWith(TASKSPACE.id, TASKSPACE.name, "README.md");
  });
});

describe("ScopeSidebar focus state", () => {
  function scopeButton(): HTMLElement {
    return screen.getByRole("button", { name: new RegExp(SCOPE.name) });
  }

  it("marks the focused scope as pressed and leaves an unfocused one unpressed", () => {
    mount({ activeScope: null });
    expect(scopeButton().getAttribute("aria-pressed")).toBe("false");

    cleanup();
    mount();
    expect(scopeButton().getAttribute("aria-pressed")).toBe("true");
  });

  // The centre mark says the board is held to this scope — cards outside it are dimmed on
  // the canvas. Resting, the frame is drawn empty, and that mark is the whole difference
  // between the two states.
  it("marks the framed region once the scope is focused", () => {
    mount({ activeScope: null });
    expect(scopeButton().querySelector("svg rect")).toBeNull();

    cleanup();
    mount();
    expect(scopeButton().querySelector("svg rect")).toBeTruthy();
  });
});
