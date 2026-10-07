import { clampZoom } from "../../[namespaceId]/lib/namespace-page.js";
import type { Point, Rect } from "./treemap.js";

/**
 * Compute pan and zoom by changing the layout rectangle instead of scaling the completed SVG.
 * Card-proportional areas grow while text, gaps, and controls retain their pixel sizes.
 *
 * The squarified packing algorithm is scale-invariant for a uniformly scaled input rectangle.
 */

export type MapView = {
  /** 1 is the map fitted to its box. Bounded by `clampZoom`, the board's own limits. */
  zoom: number;
  panX: number;
  panY: number;
};

export type Size = { width: number; height: number };

/**
 * Fitted reference view with zoom 1 and no pan. Opening zoom and displayed percentages are
 * defined separately.
 */
export const FITTED_VIEW: MapView = { zoom: 1, panX: 0, panY: 0 };

/**
 * Opening map scale relative to the fitted view. Use a map-specific default because board
 * zoom has different units. Share only `ui.zoomStep` for input sensitivity.
 */
export const DEFAULT_ZOOM = 0.5;

/**
 * Center {@link DEFAULT_ZOOM} in the current viewport. Compute it from current dimensions so
 * server and browser defaults each use their own measured box.
 */
export function defaultView(size: Size): MapView {
  const zoom = clampZoom(DEFAULT_ZOOM);
  return {
    zoom,
    panX: (size.width * (1 - zoom)) / 2,
    panY: (size.height * (1 - zoom)) / 2,
  };
}

/** Display zoom as a percentage of the opening scale, with the default view labeled 100%. */
export function zoomPercent(zoom: number): number {
  return Math.round((zoom / DEFAULT_ZOOM) * 100);
}

/**
 * How much of the map must stay on screen, in pixels.
 *
 * Panning is otherwise unbounded, and a map dragged off the edge is a blank page with no
 * indication that anything is wrong or which way to drag back. This keeps a strip of it
 * always in view, so the way back is always visible.
 */
const PAN_MARGIN = 96;

/** The rectangle the packing is laid into under this view. */
export function viewedArea(size: Size, view: MapView): Rect {
  return {
    x: view.panX,
    y: view.panY,
    width: size.width * view.zoom,
    height: size.height * view.zoom,
  };
}

/** The view with its pan brought back to where {@link PAN_MARGIN} of the map is still on
 *  screen. */
export function clampView(view: MapView, size: Size): MapView {
  const area = viewedArea(size, view);
  // The margin cannot exceed either the content or the viewport, or the interval it
  // describes would be empty and the clamp would fight itself.
  const marginX = Math.min(PAN_MARGIN, area.width, size.width);
  const marginY = Math.min(PAN_MARGIN, area.height, size.height);
  return {
    zoom: view.zoom,
    panX: Math.min(Math.max(view.panX, marginX - area.width), size.width - marginX),
    panY: Math.min(Math.max(view.panY, marginY - area.height), size.height - marginY),
  };
}

/** Zoom around a point in viewport pixels, preserving the map position under that point. */
export function zoomedTo(view: MapView, size: Size, at: Point, zoom: number): MapView {
  const next = clampZoom(zoom);
  // How much the area is about to grow by. The point keeps its position within the area, so
  // the pan moves to cancel the growth on that point's side of it.
  const growth = next / view.zoom;
  return clampView(
    {
      zoom: next,
      panX: at.x - (at.x - view.panX) * growth,
      panY: at.y - (at.y - view.panY) * growth,
    },
    size,
  );
}

/** Zoom one step around the viewport center for button controls. */
export function zoomedBy(view: MapView, size: Size, delta: number): MapView {
  return zoomedTo(view, size, { x: size.width / 2, y: size.height / 2 }, view.zoom + delta);
}

/**
 * Move the starting view by the total screen-pixel offset since drag start. This preserves
 * the return path after clamping, so returning the pointer restores the original view.
 */
export function pannedBy(view: MapView, size: Size, dx: number, dy: number): MapView {
  return clampView({ ...view, panX: view.panX + dx, panY: view.panY + dy }, size);
}

/**
 * Compare the current view with the clamped opening view so returning manually also counts as
 * reset.
 */
export function isDefaultView(view: MapView, size: Size): boolean {
  const home = clampView(defaultView(size), size);
  return view.zoom === home.zoom && view.panX === home.panX && view.panY === home.panY;
}
