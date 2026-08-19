import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
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
});
