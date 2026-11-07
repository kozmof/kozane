import { httpEditorContext } from "../../../test-utils/editor-context.js";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import KozaneCanvas from "../../../../../client/src/board/components/KozaneCanvas.svelte";
import CanvasBindingHarness from "./CanvasBindingHarness.svelte";
import { TaskspaceTreeState } from "../../../../../client/src/board/lib/taskspace-tree.svelte.js";
import type { TaskspaceSummary } from "$lib/types";
import { STRIP_GAP } from "../../../../../client/src/board/lib/scope-area-files.js";
import {
  makeProps,
  down,
  move,
  up,
  settle,
  scopeArea,
  areaTabFor,
  type Overrides,
} from "./KozaneCanvas.fixtures.js";

/**
 * Test frame file-strip integration, including eager loading, following frame movement, and
 * independent folder navigation for frames sharing a scope.
 */
describe("KozaneCanvas scope area files", () => {
  const taskspace = (id: string, name: string, scopeId: string): TaskspaceSummary => ({
    id,
    name,
    scopeId,
    path: name,
    pathKind: "workspace_relative",
  });

  /** A listing endpoint that answers from a map of path to names, and records what was asked. */
  function listings(byPath: Record<string, string[]>) {
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.searchParams.get("path") ?? "";
      asked.push(`${url.pathname}?${path}`);
      const names = byPath[path] ?? [];
      return new Response(
        JSON.stringify({
          path,
          entries: names.map((name) => ({
            name,
            kind: name.includes(".") ? "file" : "directory",
            size: null,
            modifiedAt: null,
          })),
          truncated: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    return { fetcher, asked };
  }

  function fileProps(overrides: Overrides = {}) {
    const { fetcher } = listings({ "": ["src", "app.ts"], src: ["util.ts"] });
    return makeProps({
      scopeAreas: [scopeArea()],
      scopeNameById: new Map([["s1", "Now"]]),
      taskspaces: [taskspace("t1", "work", "s1")],
      taskspaceTree: new TaskspaceTreeState(),
      treeContext: httpEditorContext(fetcher as never, "p1"),
      onOpenFile: vi.fn(),
      ...overrides,
    });
  }

  function cellFor(container: HTMLElement, label: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`no cell labelled "${label}"`);
    return found;
  }

  it("reads a framed scope's taskspace without being asked, and draws what came back", async () => {
    const { container } = render(KozaneCanvas, fileProps());
    await settle();

    expect(container.querySelector("[data-scope-area-files='a1']")).not.toBeNull();
    expect(cellFor(container, "Open folder src")).toBeInTheDocument();
    expect(cellFor(container, "Open file app.ts")).toBeInTheDocument();
  });

  it("asks only for the taskspace root, not for the tree under it", async () => {
    const { fetcher, asked } = listings({ "": ["src", "app.ts"], src: ["util.ts"] });
    render(KozaneCanvas, fileProps({ treeContext: httpEditorContext(fetcher as never, "p1") }));
    await settle();

    expect(asked).toEqual(["/p1/api/taskspaces/t1/files?"]);
  });

  it("draws nothing under a frame whose scope has no taskspace", async () => {
    const { container } = render(KozaneCanvas, fileProps({ taskspaces: [] }));
    await settle();

    expect(container.querySelector("[data-scope-area-files='a1']")).toBeNull();
  });

  it("draws nothing under a frame whose taskspace belongs to another scope", async () => {
    const { container } = render(
      KozaneCanvas,
      fileProps({ taskspaces: [taskspace("t1", "work", "s2")] }),
    );
    await settle();

    expect(container.querySelector("[data-scope-area-files='a1']")).toBeNull();
  });

  it("asks once for a taskspace framed twice, and draws the icons under both frames", async () => {
    const { fetcher, asked } = listings({ "": ["app.ts"] });
    const { container } = render(
      KozaneCanvas,
      fileProps({
        scopeAreas: [scopeArea(), scopeArea({ id: "a2", posX: 1200 })],
        treeContext: httpEditorContext(fetcher as never, "p1"),
      }),
    );
    await settle();

    expect(asked).toEqual(["/p1/api/taskspaces/t1/files?"]);
    expect(container.querySelectorAll("[data-scope-area-files]")).toHaveLength(2);
  });

  it("hands a clicked file to the editor with the taskspace it belongs to", async () => {
    const onOpenFile = vi.fn();
    const { container } = render(KozaneCanvas, fileProps({ onOpenFile }));
    await settle();

    await fireEvent.click(cellFor(container, "Open file app.ts"));

    expect(onOpenFile).toHaveBeenCalledWith("t1", "app.ts");
  });

  it("drills into a folder, reading it and drawing what is in it", async () => {
    const { container } = render(KozaneCanvas, fileProps());
    await settle();

    await fireEvent.click(cellFor(container, "Open folder src"));
    await settle();

    expect(cellFor(container, "Open file util.ts")).toBeInTheDocument();
    expect(cellFor(container, "Leave src")).toBeInTheDocument();
    expect(container.querySelector("button[aria-label='Open file app.ts']")).toBeNull();
  });

  it("comes back out to the root it was drilled into from", async () => {
    const { container } = render(KozaneCanvas, fileProps());
    await settle();

    await fireEvent.click(cellFor(container, "Open folder src"));
    await settle();
    await fireEvent.click(cellFor(container, "Leave src"));
    await settle();

    expect(cellFor(container, "Open file app.ts")).toBeInTheDocument();
  });

  it("leaves another frame of the same scope where it was", async () => {
    const { container } = render(
      KozaneCanvas,
      fileProps({ scopeAreas: [scopeArea(), scopeArea({ id: "a2", posX: 1200 })] }),
    );
    await settle();

    const first = container.querySelector<HTMLElement>("[data-scope-area-files='a1']")!;
    await fireEvent.click(
      first.querySelector<HTMLElement>("button[aria-label='Open folder src']")!,
    );
    await settle();

    const second = container.querySelector<HTMLElement>("[data-scope-area-files='a2']")!;
    // Changing one frame leaves the scope's other frames unchanged.
    expect(first.textContent).toContain("util.ts");
    expect(second.textContent).toContain("app.ts");
    expect(second.textContent).not.toContain("util.ts");
  });

  it("follows the frame as it is dragged", async () => {
    // Use the harness so row mutations update the styles through parent-owned state.
    const { cards: initialCards, visibleCards: _v, zoom: _z, ...rest } = fileProps();
    const { container } = render(CanvasBindingHarness, { initialCards, ...rest });
    await settle();

    down(areaTabFor(container, "a1"), 100, 100);
    move(148, 148);
    up();
    await settle();

    // 248 + 480 + the gap that clears the resize handle.
    expect(container.querySelector<HTMLElement>("[data-scope-area-files='a1']")).toHaveStyle({
      left: "148px",
      top: `${248 + 480 + STRIP_GAP}px`,
    });
  });

  it("draws a file as inert on a board with no editor to open it in", async () => {
    const { container } = render(KozaneCanvas, fileProps({ onOpenFile: undefined }));
    await settle();

    expect(container.querySelector("button[aria-label='Open file app.ts']")).toBeNull();
    expect(container.querySelector("[data-scope-area-files='a1']")!.textContent).toContain(
      "app.ts",
    );
  });

  it("stops asking about a taskspace once it is gone", async () => {
    const { fetcher, asked } = listings({ "": ["app.ts"] });
    const props = fileProps({ treeContext: httpEditorContext(fetcher as never, "p1") });
    const { container, rerender } = render(KozaneCanvas, props);
    await settle();

    await rerender({ ...props, taskspaces: [] });
    await settle();

    expect(asked).toEqual(["/p1/api/taskspaces/t1/files?"]);
    expect(container.querySelector("[data-scope-area-files='a1']")).toBeNull();
  });
});
