import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import ScopeAreaFiles from "./ScopeAreaFiles.svelte";
import type { ScopeArea as ScopeAreaRow, TaskspaceEntry } from "$lib/types";
import {
  CELL_WIDTH,
  MIN_STRIP_WIDTH,
  STRIP_GAP,
  type FileCell,
  type FileGroup,
} from "../lib/scope-area-files.js";

afterEach(cleanup);

const AREA: ScopeAreaRow = {
  id: "a1",
  scopeId: "s1",
  namespaceId: "p1",
  posX: 100,
  posY: 200,
  width: 640,
  height: 480,
};

const entry = (name: string, kind: TaskspaceEntry["kind"] = "file"): TaskspaceEntry => ({
  name,
  kind,
  size: null,
  modifiedAt: null,
});

const cell = (name: string, kind: TaskspaceEntry["kind"] = "file"): FileCell => ({
  kind: "entry",
  entry: entry(name, kind),
  path: name,
});

function group(overrides: Partial<FileGroup> = {}): FileGroup {
  return {
    taskspaceId: "t1",
    name: "work",
    path: "",
    cells: [cell("src", "directory"), cell("app.ts")],
    truncated: null,
    loading: false,
    error: null,
    read: true,
    ...overrides,
  };
}

function mount(overrides: Record<string, unknown> = {}) {
  const onOpenFile = vi.fn();
  const onNavigate = vi.fn();
  const rendered = render(ScopeAreaFiles, {
    props: { area: AREA, groups: [group()], onOpenFile, onNavigate, ...overrides },
  });
  return { ...rendered, onOpenFile, onNavigate };
}

function strip(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-scope-area-files='a1']")!;
}

describe("ScopeAreaFiles", () => {
  it("draws the cells a group was given", () => {
    mount();
    expect(screen.getByRole("button", { name: "Open folder src" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open file app.ts" })).toBeInTheDocument();
  });

  it("hangs below the frame's bottom edge, outside the frame", () => {
    const { container } = mount();
    expect(strip(container)).toHaveStyle({
      left: `${AREA.posX + AREA.width - AREA.width}px`,
      top: `${AREA.posY + AREA.height + STRIP_GAP}px`,
      width: `${AREA.width}px`,
    });
  });

  it("stays as wide as the minimum under a frame too narrow to lay cells out in", () => {
    const { container } = mount({ area: { ...AREA, posX: 1000, width: 120 } });
    expect(strip(container)).toHaveStyle({
      width: `${MIN_STRIP_WIDTH}px`,
      // Align the strip with the frame's right edge at 1000 + 120 - 260.
      left: `${1000 + 120 - MIN_STRIP_WIDTH}px`,
    });
  });

  it("does not lay its icons off the left of the board", () => {
    const { container } = mount({ area: { ...AREA, posX: 0, width: 120 } });
    expect(strip(container)).toHaveStyle({ left: "0px" });
  });

  it("takes no pointer events itself, so panning through the gaps still works", () => {
    const { container } = mount();
    expect(strip(container)).toHaveStyle({ pointerEvents: "none" });
    expect(screen.getByRole("button", { name: "Open file app.ts" })).toHaveStyle({
      pointerEvents: "auto",
    });
  });

  it("opens a file when its cell is clicked", async () => {
    const { onOpenFile } = mount();

    await fireEvent.click(screen.getByRole("button", { name: "Open file app.ts" }));

    expect(onOpenFile).toHaveBeenCalledWith("t1", "app.ts");
  });

  it("drills into a folder when its cell is clicked", async () => {
    const { onNavigate } = mount();

    await fireEvent.click(screen.getByRole("button", { name: "Open folder src" }));

    expect(onNavigate).toHaveBeenCalledWith("t1", "src");
  });

  it("walks back out of a directory it was drilled into", async () => {
    const { onNavigate } = mount({
      groups: [
        group({
          path: "src/lib",
          cells: [
            { kind: "up", label: "lib", path: "src" },
            { kind: "entry", entry: entry("util.ts"), path: "src/lib/util.ts" },
          ],
        }),
      ],
    });

    await fireEvent.click(screen.getByRole("button", { name: "Leave lib" }));

    expect(onNavigate).toHaveBeenCalledWith("t1", "src");
  });

  it("swallows the mousedown, which the canvas underneath would read as a pan", async () => {
    mount();
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    screen.getByRole("button", { name: "Open file app.ts" }).dispatchEvent(event);

    expect(stopPropagation).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("draws a file as inert where the board has no editor to open it in", () => {
    mount({ onOpenFile: undefined });

    expect(screen.queryByRole("button", { name: "Open file app.ts" })).not.toBeInTheDocument();
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    // Folder browsing remains available with the board's existing data.
    expect(screen.getByRole("button", { name: "Open folder src" })).toBeInTheDocument();
  });

  it("draws a symlink as itself and leaves it shut", () => {
    mount({ groups: [group({ cells: [cell("link", "symlink")] })] });

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByTitle("Symbolic link")).toBeInTheDocument();
  });

  it("says a directory is being read rather than showing it as empty", () => {
    mount({ groups: [group({ cells: [], read: false, loading: true })] });

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("Empty")).not.toBeInTheDocument();
  });

  it("says a directory that really is empty is empty", () => {
    mount({ groups: [group({ cells: [] })] });

    expect(screen.getByText("Empty")).toBeInTheDocument();
  });

  it("shows nothing at all for a directory not read and not being read", () => {
    const { container } = mount({ groups: [group({ cells: [], read: false })] });

    expect(container.textContent?.trim()).toBe("");
  });

  it("reports a listing that failed, in place of the cells", () => {
    mount({ groups: [group({ error: "Failed to list files" })] });

    expect(screen.getByText("Failed to list files")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says why a listing was cut off", () => {
    mount({ groups: [group({ truncated: "entries" })] });

    expect(screen.getByText("First 500 entries only")).toBeInTheDocument();
  });

  it("counts the cells past the second row rather than drawing a third", () => {
    const many = Array.from({ length: 30 }, (_, i) => cell(`f${i}.ts`));
    mount({ groups: [group({ cells: many })] });

    // Ten columns across a 640px strip, two rows, one slot to the count.
    const columns = Math.floor(AREA.width / CELL_WIDTH);
    const shown = columns * 2 - 1;
    expect(screen.getAllByRole("button")).toHaveLength(shown);
    expect(screen.getByText(`+${30 - shown} more`)).toBeInTheDocument();
  });

  it("leaves the count a label, not a control", () => {
    const many = Array.from({ length: 30 }, (_, i) => cell(`f${i}.ts`));
    mount({ groups: [group({ cells: many })] });

    const note = screen.getByText(/more$/);
    expect(note.tagName).toBe("SPAN");
    expect(note).toHaveAttribute("title", expect.stringContaining("scope panel"));
  });

  it("names each taskspace once a scope has more than one", () => {
    mount({
      groups: [
        group({ taskspaceId: "t1", name: "work" }),
        group({ taskspaceId: "t2", name: "notes" }),
      ],
    });

    expect(screen.getByText("work")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
  });

  it("writes no name over a scope's only taskspace, which the tab already names", () => {
    mount();
    expect(screen.queryByText("work")).not.toBeInTheDocument();
  });

  it("says which directory a named taskspace is showing", () => {
    mount({
      groups: [
        group({ taskspaceId: "t1", name: "work", path: "src/lib" }),
        group({ taskspaceId: "t2", name: "notes" }),
      ],
    });

    expect(screen.getByText("work/src/lib")).toBeInTheDocument();
  });

  it("draws each taskspace's cells under its own id", () => {
    const { container } = mount({
      groups: [
        group({ taskspaceId: "t1", cells: [cell("a.ts")] }),
        group({ taskspaceId: "t2", cells: [cell("b.ts")] }),
      ],
    });

    const first = container.querySelector<HTMLElement>("[data-taskspace-id='t1']")!;
    expect(first.textContent).toContain("a.ts");
    expect(first.textContent).not.toContain("b.ts");
  });
});
