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
 * Read canvas bounds, scroll offsets, and zoom for coordinate conversion and viewport
 * movement. Use getters because the bound element and props can change.
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

  /** Round a canvas point to whole pixels and clamp it to the board. */
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
   * Whether the viewport is as centered on this point as canvas bounds allow. See
   * `isViewCenteredOn`.
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
