import { describe, expect, it, vi } from "vitest";
import { CardPlacement, type PlacementRequest } from "./card-placement.js";
import { GRID, type PositionedCardSize } from "./namespace-page.js";

/**
 * A board 800x600 scrolled to the origin at zoom 1, which is the simplest viewport the run
 * rules can be asked about. `scroll` moves it.
 */
function request(overrides: Partial<PlacementRequest> = {}): PlacementRequest {
  return {
    seq: 1,
    viewport: { scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600 },
    zoom: 1,
    cardWidth: 240,
    placement: "grid",
    measureAt: () => [],
    ...overrides,
  };
}

function scrolled(left: number, top: number): PlacementRequest["viewport"] {
  return { scrollLeft: left, scrollTop: top, clientWidth: 800, clientHeight: 600 };
}

describe("CardPlacement, grid runs", () => {
  it("puts the first card of a run in the middle of the view", () => {
    const placement = new CardPlacement();
    const { posX, posY } = placement.next(request({ seq: 0 }));
    // Center the card horizontally on the snapped position and place it two grid steps above
    // the center line.
    expect(posX).toBe(Math.round((Math.round(400 / GRID) * GRID - 120) / GRID) * GRID);
    expect(posY).toBe(Math.round(300 / GRID) * GRID - 2 * GRID);
    expect(posX % GRID).toBe(0);
    expect(posY % GRID).toBe(0);
  });

  it("lays a run out four to a row", () => {
    const placement = new CardPlacement();
    const run = [0, 1, 2, 3, 4].map((seq) => placement.next(request({ seq })));
    const [first] = run;
    expect(run[1]).toEqual({ posX: first.posX + 6 * GRID, posY: first.posY });
    expect(run[3]).toEqual({ posX: first.posX + 18 * GRID, posY: first.posY });
    // The fifth starts the next row, back at the first column.
    expect(run[4]).toEqual({ posX: first.posX, posY: first.posY + 4 * GRID });
  });

  it("starts a new run when the caller asks for one", () => {
    const placement = new CardPlacement();
    const first = placement.next(request({ seq: 0 }));
    placement.next(request({ seq: 1 }));
    // `seq: 0` is how a caller says "new batch", whatever came before it.
    expect(placement.next(request({ seq: 0 }))).toEqual(first);
  });

  it("starts a new run once the board has been scrolled", () => {
    const placement = new CardPlacement();
    placement.next(request({ seq: 0 }));
    // Scrolled deliberately, so the next card belongs to the view it is in now rather than
    // to the column the user has scrolled away from.
    const after = placement.next(request({ seq: 1, viewport: scrolled(480, 240) }));
    const fresh = new CardPlacement().next(request({ seq: 0, viewport: scrolled(480, 240) }));
    expect(after).toEqual(fresh);
  });

  it("does not treat a pixel of scroll drift as a scroll", () => {
    const placement = new CardPlacement();
    const first = placement.next(request({ seq: 0 }));
    const second = placement.next(request({ seq: 1, viewport: scrolled(1, 1) }));
    // Still the second slot of the same row, not a restarted run.
    expect(second).toEqual({ posX: first.posX + 6 * GRID, posY: first.posY });
  });

  it("continues a run while the board stays put", () => {
    const placement = new CardPlacement();
    const first = placement.next(request({ seq: 0 }));
    const second = placement.next(request({ seq: 1 }));
    expect(second).not.toEqual(first);
    expect(second.posX).toBe(first.posX + 6 * GRID);
  });

  it("forgets the run when reset", () => {
    const placement = new CardPlacement();
    const first = placement.next(request({ seq: 0 }));
    placement.next(request({ seq: 1 }));
    placement.reset();
    // `seq: 1` with no run open behaves as the first of one.
    expect(placement.next(request({ seq: 1 }))).toEqual(first);
  });

  it("measures the view in world pixels, so zoom moves where a card lands", () => {
    const placement = new CardPlacement();
    const atOne = placement.next(request({ seq: 0 }));
    const atHalf = new CardPlacement().next(request({ seq: 0, zoom: 0.5 }));
    expect(atHalf.posX).toBeGreaterThan(atOne.posX);
  });

  it("never places a card off the left or top of the board", () => {
    const placement = new CardPlacement();
    // A card wider than the viewport could otherwise start beyond the left edge.
    const { posX, posY } = placement.next(request({ seq: 0, cardWidth: 4000 }));
    expect(posX).toBe(0);
    expect(posY).toBeGreaterThanOrEqual(0);
  });

  it("asks for no measurements at all on the grid path", () => {
    const measureAt = vi.fn(() => [] as PositionedCardSize[]);
    const placement = new CardPlacement();
    placement.next(request({ seq: 0, measureAt }));
    placement.next(request({ seq: 1, measureAt }));
    expect(measureAt).not.toHaveBeenCalled();
  });
});

describe("CardPlacement, vertical-list runs", () => {
  const list = (overrides: Partial<PlacementRequest> = {}) =>
    request({ placement: "vertical-list", ...overrides });

  it("does not measure for the first card of a run", () => {
    // There is nothing above it yet, so there is nothing to measure against.
    const measureAt = vi.fn(() => [] as PositionedCardSize[]);
    new CardPlacement().next(list({ seq: 0, measureAt }));
    expect(measureAt).not.toHaveBeenCalled();
  });

  it("measures at the previous card's position for the next one", () => {
    const measureAt = vi.fn(() => [] as PositionedCardSize[]);
    const placement = new CardPlacement();
    const first = placement.next(list({ seq: 0, measureAt }));
    placement.next(list({ seq: 1, measureAt }));
    expect(measureAt).toHaveBeenCalledWith({ x: first.posX, y: first.posY });
  });

  it("drops the next card below the one above it, by what that one measured", () => {
    const placement = new CardPlacement();
    const first = placement.next(list({ seq: 0 }));
    const second = placement.next(
      list({
        seq: 1,
        measureAt: (at) => [{ posX: at.x, posY: at.y, width: 240, height: 96 }],
      }),
    );
    expect(second.posX).toBe(first.posX);
    expect(second.posY).toBeGreaterThanOrEqual(first.posY + 96);
    expect(second.posY % GRID).toBe(0);
  });

  it("stacks a run of three down one column", () => {
    const placement = new CardPlacement();
    const measureAt = (at: { x: number; y: number }) => [
      { posX: at.x, posY: at.y, width: 240, height: 48 },
    ];
    const run = [0, 1, 2].map((seq) => placement.next(list({ seq, measureAt })));
    expect(new Set(run.map(({ posX }) => posX)).size).toBe(1);
    expect(run[1].posY).toBeGreaterThan(run[0].posY);
    expect(run[2].posY).toBeGreaterThan(run[1].posY);
  });

  it("starts a fresh column once the board has been scrolled", () => {
    const placement = new CardPlacement();
    const measureAt = (at: { x: number; y: number }) => [
      { posX: at.x, posY: at.y, width: 240, height: 48 },
    ];
    placement.next(list({ seq: 0, measureAt }));
    const after = placement.next(list({ seq: 1, viewport: scrolled(0, 600), measureAt }));
    const fresh = new CardPlacement().next(list({ seq: 0, viewport: scrolled(0, 600), measureAt }));
    expect(after).toEqual(fresh);
  });
});
