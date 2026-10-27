import { CANVAS_W, INVENTORY_SLOT_MAX } from "./constants.js";
import { cardSpan, lastCell, planStow } from "./inventory.js";

/**
 * Split at a period followed by whitespace, at `。`, or at a blank line. Preserve periods
 * followed by non-whitespace, as in `example.com`.
 */
export const DEFAULT_SQUASH_PATTERN = String.raw`\.\s|。|\r?\n[ \t]*\r?\n`;

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
  /** Available board width. Defaults to the built-in canvas width. */
  canvasWidth?: number;
};

/**
 * Place cards in free grid slots, filling rows left to right and wrapping at the board edge.
 * Spacing is fixed because rendered heights are unavailable, so long cards may overlap later
 * rows.
 */
export function squashCardPositions(
  occupied: CardPosition[],
  count: number,
  { origin = { posX: 0, posY: 0 }, canvasWidth = CANVAS_W }: SquashLayout = {},
): CardPosition[] {
  // Allow at least one column near the right edge. The caller clamps stored positions to the
  // board.
  const columns = Math.max(1, Math.floor((canvasWidth - origin.posX) / SQUASH_COLUMN_SPACING));
  const occupiedKeys = new Set(occupied.map(({ posX, posY }) => `${posX},${posY}`));
  // Bound the search by requested cards plus occupied slots. This provides enough free
  // distinct slots without risking an endless loop if placement arithmetic changes.
  const slotLimit = count + occupiedKeys.size;
  const positions: CardPosition[] = [];
  for (let slot = 0; positions.length < count && slot < slotLimit; slot++) {
    const position = {
      posX: origin.posX + (slot % columns) * SQUASH_COLUMN_SPACING,
      posY: origin.posY + Math.floor(slot / columns) * SQUASH_ROW_SPACING,
    };
    const key = `${position.posX},${position.posY}`;
    if (occupiedKeys.has(key)) continue;
    occupiedKeys.add(key);
    positions.push(position);
  }
  // Return one position per card even if the bound above fails. Fall back to the origin for
  // any remaining positions.
  while (positions.length < count) positions.push({ ...origin });
  return positions;
}

/**
 * Plan the slots of squashed pieces in a new, empty inventory, in text order. Return null when
 * the pieces would pass {@link INVENTORY_SLOT_MAX}, so the caller can refuse before writing.
 */
export function squashInventorySlots(contents: readonly string[]): number[] | null {
  const sized = contents.map((content, index) => ({
    cardId: String(index),
    span: cardSpan(content),
  }));
  const plan = planStow([], sized, null);
  const slotOf = new Map(plan.map(({ cardId, slot }) => [cardId, slot]));
  const slots = sized.map(({ cardId }) => slotOf.get(cardId)!);
  const fits = sized.every(({ span }, index) => lastCell(slots[index], span) <= INVENTORY_SLOT_MAX);
  return fits ? slots : null;
}

const SQUASH_INVENTORY_NAME = /^Squash (\d+)$/;

/** The next free "Squash N" name, one past the highest N already taken. */
export function nextSquashInventoryName(existingNames: Iterable<string>): string {
  let highest = 0;
  for (const name of existingNames) {
    const match = SQUASH_INVENTORY_NAME.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `Squash ${highest + 1}`;
}
