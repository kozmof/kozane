import { clamp } from "$lib/constants";
import {
  centeredScrollOffset,
  clientToWorld,
  isViewCenteredOn,
  scrollForViewCenter,
  viewCenterWorld,
  worldRectToScreenRect,
  type Point,
  type RectBounds,
  type ScreenRect,
  type WorldRect,
} from "./namespace-page.js";

/** A point on the board, in the column names the rows use. */
export type BoardPoint = { posX: number; posY: number };

/**
 * The board's scroll container read as a window onto the canvas: where it is looking, how a
 * pointer maps into world coordinates and back, and how to move it.
 *
 * Every question here is the same three readings — the element's box, its scroll offset, and
 * the zoom — put through one of the pure functions in `namespace-page.ts`. `KozaneCanvas`
 * asked them inline, a dozen times over, each spelling out `canvasEl.scrollLeft` and
 * `canvasEl.scrollTop` for itself. The arithmetic was already tested; this is the one place
 * that feeds it the DOM.
 *
 * Takes getters rather than values because all three change under it: the element is bound
 * after the component's script runs, and zoom and the canvas size are props.
 */
export class CanvasViewport {
  readonly #el: () => HTMLElement;
  readonly #zoom: () => number;
  readonly #bounds: () => RectBounds;

  constructor(el: () => HTMLElement, zoom: () => number, bounds: () => RectBounds) {
    this.#el = el;
    this.#zoom = zoom;
    this.#bounds = bounds;
  }

  #scroll(): Point {
    const el = this.#el();
    return { x: el.scrollLeft, y: el.scrollTop };
  }

  /** A client (pointer) position, in world coordinates. */
  toWorld(clientX: number, clientY: number): Point {
    return clientToWorld(
      clientX,
      clientY,
      this.#el().getBoundingClientRect(),
      this.#scroll(),
      this.#zoom(),
    );
  }

  /** A world rectangle, in the client coordinates `getBoundingClientRect` reports. */
  toScreen(rect: WorldRect): ScreenRect {
    return worldRectToScreenRect(
      rect,
      this.#el().getBoundingClientRect(),
      this.#scroll(),
      this.#zoom(),
    );
  }

  /** Whether a client position falls over the board rather than a panel beside it. */
  contains({ x, y }: Point): boolean {
    const rect = this.#el().getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  /** A world point rounded to whole pixels and kept on the canvas — what the server stores. */
  onCanvas({ x, y }: Point): BoardPoint {
    const { canvasWidth, canvasHeight } = this.#bounds();
    return {
      posX: clamp(Math.round(x), 0, canvasWidth),
      posY: clamp(Math.round(y), 0, canvasHeight),
    };
  }

  /** Where the viewport is looking, in world coordinates. */
  center(): BoardPoint {
    const el = this.#el();
    const zoom = this.#zoom();
    return this.onCanvas({
      x: viewCenterWorld(el.scrollLeft, el.clientWidth, zoom),
      y: viewCenterWorld(el.scrollTop, el.clientHeight, zoom),
    });
  }

  /** Back to the middle of the board. */
  recenter(): void {
    const el = this.#el();
    el.scrollLeft = centeredScrollOffset(el.scrollWidth, el.clientWidth);
    el.scrollTop = centeredScrollOffset(el.scrollHeight, el.clientHeight);
  }

  /** Moves the viewport so `posX`/`posY` sits in the middle of it. Zoom is left alone. */
  centerOn(posX: number, posY: number): void {
    const el = this.#el();
    const zoom = this.#zoom();
    el.scrollLeft = scrollForViewCenter(
      posX,
      el.clientWidth,
      zoom,
      el.scrollWidth - el.clientWidth,
    );
    el.scrollTop = scrollForViewCenter(
      posY,
      el.clientHeight,
      zoom,
      el.scrollHeight - el.clientHeight,
    );
  }

  /**
   * Whether the viewport already shows this point as centred as the board allows — near an
   * edge a point cannot reach the middle at all. See `isViewCenteredOn`.
   */
  isCenteredOn(posX: number, posY: number): boolean {
    const el = this.#el();
    const zoom = this.#zoom();
    return (
      isViewCenteredOn(
        el.scrollLeft,
        posX,
        el.clientWidth,
        zoom,
        el.scrollWidth - el.clientWidth,
      ) &&
      isViewCenteredOn(el.scrollTop, posY, el.clientHeight, zoom, el.scrollHeight - el.clientHeight)
    );
  }
}
