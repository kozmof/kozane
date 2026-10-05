import { describe, expect, it } from "vitest";
import { CanvasViewport } from "./canvas-viewport.js";

/** A scroll container 400×300 on screen at (10, 20), over a 2000×1600 scrolled area. */
function container() {
  return {
    scrollLeft: 100,
    scrollTop: 50,
    clientWidth: 400,
    clientHeight: 300,
    scrollWidth: 2000,
    scrollHeight: 1600,
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 410, bottom: 320 }),
  } as unknown as HTMLElement;
}

function viewportOf(el: HTMLElement, zoom = 2) {
  return new CanvasViewport(
    () => el,
    () => zoom,
    () => ({ canvasWidth: 1000, canvasHeight: 800 }),
  );
}

describe("CanvasViewport", () => {
  it("maps a pointer to world coordinates and a world rectangle back", () => {
    const viewport = viewportOf(container());
    expect(viewport.toWorld(30, 40)).toEqual({ x: 60, y: 35 });
    expect(viewport.toScreen({ x: 60, y: 35, w: 10, h: 5 })).toEqual({
      left: 30,
      top: 40,
      right: 50,
      bottom: 50,
    });
  });

  it("tells a pointer over the board from one beside it", () => {
    const viewport = viewportOf(container());
    expect(viewport.contains({ x: 10, y: 20 })).toBe(true);
    expect(viewport.contains({ x: 410, y: 320 })).toBe(true);
    expect(viewport.contains({ x: 411, y: 100 })).toBe(false);
  });

  it("rounds and clamps a point to the canvas", () => {
    const viewport = viewportOf(container());
    expect(viewport.onCanvas({ x: 12.6, y: -4 })).toEqual({ posX: 13, posY: 0 });
    expect(viewport.onCanvas({ x: 5000, y: 900 })).toEqual({ posX: 1000, posY: 800 });
  });

  it("reports where the view is centred", () => {
    // (100 + 400 / 2) / 2 = 150, (50 + 300 / 2) / 2 = 100
    expect(viewportOf(container()).center()).toEqual({ posX: 150, posY: 100 });
  });

  it("centres on a point and then reports it as centred", () => {
    const el = container();
    const viewport = viewportOf(el);
    viewport.centerOn(300, 200);
    expect(el.scrollLeft).toBe(400);
    expect(el.scrollTop).toBe(250);
    expect(viewport.isCenteredOn(300, 200)).toBe(true);
    expect(viewport.isCenteredOn(320, 200)).toBe(false);
  });

  it("recentres on the middle of the scrolled area", () => {
    const el = container();
    viewportOf(el).recenter();
    expect(el.scrollLeft).toBe(800);
    expect(el.scrollTop).toBe(650);
  });
});
