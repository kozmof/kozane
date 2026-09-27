import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import ScopeArea from "./ScopeArea.svelte";
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
      ...overrides,
    },
  });
  return { ...rendered, onMouseDown, onResizeMouseDown };
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

    // The whole reason a frame can be drawn under the cards at all: everything that works on
    // bare canvas — clicking a card, dragging one, sweeping a selection — has to keep
    // working over the middle of a frame.
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
