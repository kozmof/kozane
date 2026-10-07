import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import ScopeArea from "./ScopeArea.svelte";
import { token } from "styled-system/tokens";
import type { ScopeArea as ScopeAreaRow } from "$lib/types";

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

function mount(overrides: Record<string, unknown> = {}) {
  const onMouseDown = vi.fn();
  const onResizeMouseDown = vi.fn();
  const onRemove = vi.fn();
  const rendered = render(ScopeArea, {
    props: {
      area: AREA,
      name: "Now",
      focused: false,
      draggable: true,
      dragging: false,
      resizing: false,
      onMouseDown,
      onResizeMouseDown,
      onRemove,
      ...overrides,
    },
  });
  return { ...rendered, onMouseDown, onResizeMouseDown, onRemove };
}

describe("ScopeArea", () => {
  it("draws the frame at the scope's rectangle", () => {
    const { container } = mount();
    const frame = container.querySelector<HTMLElement>("[data-scope-area-id='a1']")!;

    expect(frame).toHaveStyle({
      left: "100px",
      top: "200px",
      width: "640px",
      height: "480px",
    });
  });

  it("writes the scope's name on the tab", () => {
    mount();
    expect(screen.getByRole("button", { name: "Scope area Now" })).toHaveTextContent("Now");
  });

  it("takes no pointer events on the body, so cards inside stay clickable", () => {
    const { container } = mount();
    const frame = container.querySelector<HTMLElement>("[data-scope-area-id='a1']")!;

    // Keep canvas interactions available through the frame body.
    expect(frame).toHaveStyle({ "pointer-events": "none" });
    expect(screen.getByRole("button", { name: "Scope area Now" })).toHaveStyle({
      "pointer-events": "auto",
    });
  });

  it("reports a press on the tab", async () => {
    const { onMouseDown } = mount();

    await fireEvent.mouseDown(screen.getByRole("button", { name: "Scope area Now" }));

    expect(onMouseDown).toHaveBeenCalledOnce();
  });

  it("reports a press on the resize handle", async () => {
    const { onResizeMouseDown } = mount();

    await fireEvent.mouseDown(screen.getByRole("button", { name: "Resize scope area Now" }));

    expect(onResizeMouseDown).toHaveBeenCalledOnce();
  });

  it("marks the frame of the focused scope as pressed", () => {
    mount({ focused: true });
    expect(screen.getByRole("button", { name: "Scope area Now" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers no resize handle on a read-only board", () => {
    mount({ draggable: false });
    expect(screen.queryByRole("button", { name: /Resize scope area/ })).toBeNull();
  });
});

/**
 * Verify colors against generated tokens because jsdom cannot distinguish valid CSS variables
 * from unresolved names.
 */
describe("ScopeArea colours", () => {
  function frameBody(container: HTMLElement): HTMLElement {
    const found = container.querySelector<HTMLElement>("[data-scope-area-id='a1'] div");
    if (!found) throw new Error("no frame body");
    return found;
  }

  it("draws the frame in a defined colour when the scope is not focused", () => {
    const { container } = mount({ focused: false });
    const body = frameBody(container);

    // Keep the frame visible when its scope is not the active filter.
    expect(body.style.border).toBe(`1px solid ${token.var("colors.neutral.iconDim")}`);
    expect(body.style.background).toContain(token.var("colors.neutral.iconDim"));
  });

  it("draws the frame in the selection accent when the scope is focused", () => {
    const { container } = mount({ focused: true });
    expect(frameBody(container).style.border).toBe(
      `1px solid ${token.var("colors.select.accent")}`,
    );
  });
});
