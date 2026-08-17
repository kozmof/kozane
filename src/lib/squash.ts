import { CANVAS_W } from "./constants.js";

/**
 * Splits on `. ` (a period followed by a space), `。`, or a blank line. A period without a
 * space after it is left alone, so `example.com` survives as one word.
 */
export const DEFAULT_SQUASH_PATTERN = String.raw`\. |。|\r?\n[ \t]*\r?\n`;

export function splitCardContent(content: string, pattern = DEFAULT_SQUASH_PATTERN): string[] {
  return content
    .split(new RegExp(pattern))
    .map((part) => part.trim())
    .filter(Boolean);
}

const SQUASH_COLUMN_SPACING = 280;
const SQUASH_ROW_SPACING = 160;

export type CardPosition = { posX: number; posY: number };

type SquashLayout = {
  /** Where the first slot sits. The CLI squashes onto the board itself and starts at 0,0. */
  origin?: CardPosition;
  /** The board the columns have to fit inside, defaulting to the built-in canvas width. */
  canvasWidth?: number;
};

/**
 * Grid slots for `count` cards, skipping any slot a card already sits on. Rows fill left to
 * right and wrap at the right-hand edge of the board.
 *
 * Nothing here knows how tall a card is drawn — that depends on its text, its width, and
 * the font — so the spacing is fixed rather than measured, and a long card may still
 * overlap the one below it until someone drags it.
 */
export function squashCardPositions(
  occupied: CardPosition[],
  count: number,
  { origin = { posX: 0, posY: 0 }, canvasWidth = CANVAS_W }: SquashLayout = {},
): CardPosition[] {
  // At least one: an origin within a column's width of the right edge still has to put its
  // cards somewhere, and a column count of zero would place every one of them on top of the
  // last. They are clamped back onto the board by the caller that stores them.
  const columns = Math.max(1, Math.floor((canvasWidth - origin.posX) / SQUASH_COLUMN_SPACING));
  const occupiedKeys = new Set(occupied.map(({ posX, posY }) => `${posX},${posY}`));
  const positions: CardPosition[] = [];
  for (let slot = 0; positions.length < count; slot++) {
    const position = {
      posX: origin.posX + (slot % columns) * SQUASH_COLUMN_SPACING,
      posY: origin.posY + Math.floor(slot / columns) * SQUASH_ROW_SPACING,
    };
    const key = `${position.posX},${position.posY}`;
    if (occupiedKeys.has(key)) continue;
    occupiedKeys.add(key);
    positions.push(position);
  }
  return positions;
}
