import { clampZoom } from "../../[projectId]/lib/project-page.js";
import type { Point, Rect } from "./treemap.js";

/**
 * Panning and zooming the map, as arithmetic.
 *
 * The map is a packing rather than a scene, so the view is not applied to it afterwards the
 * way a `<g transform>` would: it decides the rectangle the packing is laid out *into*. At
 * 100% with no pan that rectangle is the box on the page, which is what the map has always
 * been drawn into; zoomed to 200% it is a rectangle twice that size, positioned by the pan.
 *
 * The difference is what happens to everything that is measured in pixels rather than in
 * cards. A `<g transform>` scales the lot — a project's title band, the gaps between
 * rectangles, the labels, the scope rail — so zooming in to read a small bundle's name
 * enlarges the name along with the box and it is no more readable than it was. Laying out
 * into a larger rectangle scales only what is proportional to card counts, which is exactly
 * the part zooming in is for: the boxes grow, the type stays the size type should be, and a
 * bundle too small to be labelled becomes large enough to carry its label.
 *
 * Squarifying is scale-invariant, so this is safe: multiplying the area by a constant
 * multiplies every candidate row's worst aspect ratio by nothing at all, and the algorithm
 * takes the same decisions. Zooming therefore magnifies the map rather than rearranging it.
 */

export type MapView = {
  /** 1 is the map fitted to its box. Bounded by `clampZoom`, the board's own limits. */
  zoom: number;
  panX: number;
  panY: number;
};

/**
 * Where the map opens, always.
 *
 * `ui.defaultZoom` is deliberately not read here, though the board opens at it. On a board,
 * zoom 1 means one canvas pixel per screen pixel and a workspace may well want to sit at
 * another ratio; on the map, 1 means *fitted to the box*, and a map that opened part-scrolled
 * would be a map you had to put back before you could read it. `ui.zoomStep` is shared,
 * because that is about the input device rather than about either page.
 */
export const FITTED_VIEW: MapView = { zoom: 1, panX: 0, panY: 0 };

/**
 * How much of the map must stay on screen, in pixels.
 *
 * Panning is otherwise unbounded, and a map dragged off the edge is a blank page with no
 * indication that anything is wrong or which way to drag back. This keeps a strip of it
 * always in view, so the way back is always visible.
 */
const PAN_MARGIN = 96;

export type Size = { width: number; height: number };

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

/**
 * The view zoomed to `zoom`, with `at` — a point in the box, in its own pixels — left where
 * it was.
 *
 * That is what makes a wheel zoom feel attached to the pointer: the bundle under the cursor
 * is the one that stays put, rather than the top-left corner, so zooming in on something is
 * done by pointing at it.
 */
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

/** The view zoomed a step, about the middle of the box — what the `−` and `+` buttons do,
 *  neither of which is pointing anywhere in particular the way the wheel is. */
export function zoomedBy(view: MapView, size: Size, delta: number): MapView {
  return zoomedTo(view, size, { x: size.width / 2, y: size.height / 2 }, view.zoom + delta);
}

/**
 * The view moved by a screen-pixel offset.
 *
 * A drag passes the view it *began* at and how far the pointer has travelled altogether,
 * rather than the last view and the last few pixels. Both give the same answer until the
 * clamp bites, and then they differ in a way that is felt: applied step by step, a drag that
 * ran past the edge would have to travel back through everything the clamp had thrown away
 * before the map moved again. Computed from where the drag began, the map is under the
 * pointer wherever the pointer goes, and returning the pointer returns the map.
 */
export function pannedBy(view: MapView, size: Size, dx: number, dy: number): MapView {
  return clampView({ ...view, panX: view.panX + dx, panY: view.panY + dy }, size);
}
