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
  pathKind: "workspace_relative" as const,
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
  const rendered = render(ScopeSidebar, {
    props: {
      visible: true,
      panelWidth: 240,
      scopes: [SCOPE],
      scopeRels: [],
      taskspaces: [TASKSPACE],
      taskspaceTree: new TaskspaceTreeState(),
      treeContext: { fetcher: fetcher as never, namespaceId: "namespace-1" },
      selectedCards: new Set<string>(),
      // The taskspace rows only exist under the open scope.
      activeScope: SCOPE.id,
      newScopeName: "",
      newWcName: "",
      onCreateScope: () => {},
      onDeleteScope: () => {},
      onAddToScope: () => {},
      onRemoveFromScope: () => {},
      frameCountByScopeId: new Map<string, number>(),
      onCreateTaskspace: () => {},
      ...overrides,
    },
  });
  return { ...rendered, fetcher };
}

describe("ScopeSidebar taskspaces", () => {
  it("opens a taskspace and lists what is in it", async () => {
    const { fetcher } = mount();

    await userEvent.click(screen.getByRole("button", { name: /demo/ }));

    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(fetcher).toHaveBeenCalledWith("/namespace-1/api/taskspaces/taskspace-1/files");
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

  // Omit taskspace rows that have neither a live path nor an embedded tree, matching exports
  // that contain no browsable files.
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
          namespaceId: "namespace-1",
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
        frameCountByScopeId: new Map<string, number>(),
        onCreateTaskspace: () => {},
        onOpenFile,
        readonly: true,
      },
    });

    await userEvent.click(screen.getByRole("button", { name: /demo/ }));
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();

    // Hide write and refresh controls in static exports, which have no backing filesystem.
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

  // Show the center mark only for the scope currently filtering the board.
  it("marks the framed region once the scope is focused", () => {
    mount({ activeScope: null });
    expect(scopeButton().querySelector("svg rect")).toBeNull();

    cleanup();
    mount();
    expect(scopeButton().querySelector("svg rect")).toBeTruthy();
  });
});

describe("ScopeSidebar scope areas", () => {
  /** The panel's frame indicator for the one scope these tests mount. */
  function frameMark(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>("[title^='Framed']");
  }

  it("says nothing for a scope with no frames", () => {
    const { container } = mount();
    expect(frameMark(container)).toBeNull();
  });

  it("marks a scope framed once without a number", () => {
    const { container } = mount({ frameCountByScopeId: new Map([[SCOPE.id, 1]]) });

    // The glyph alone is the whole story at one, and a "1" beside it would only invite the
    // question of what else it could have been.
    expect(frameMark(container)?.textContent?.trim()).toBe("▣");
    expect(frameMark(container)).toHaveAttribute("title", "Framed once on this board");
  });

  it("counts the frames when a scope has more than one", () => {
    const { container } = mount({ frameCountByScopeId: new Map([[SCOPE.id, 3]]) });

    expect(frameMark(container)?.textContent?.trim()).toBe("▣3");
    expect(frameMark(container)).toHaveAttribute("title", "Framed in 3 places on this board");
  });

  // Report frame status without a removal action because a scope may have multiple frames.
  // Remove each frame on the canvas.
  it("offers no button to remove a frame", () => {
    mount({ frameCountByScopeId: new Map([[SCOPE.id, 2]]) });
    expect(screen.queryByRole("button", { name: /frame/i })).toBeNull();
  });

  it("shows nothing on a read-only board", () => {
    const { container } = mount({
      frameCountByScopeId: new Map([[SCOPE.id, 1]]),
      readonly: true,
    });
    expect(frameMark(container)).toBeNull();
  });
});
