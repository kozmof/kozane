import {
  INVENTORY_CELL,
  INVENTORY_COLUMNS,
  INVENTORY_MIN_ROWS,
  INVENTORY_SPAN_MAX,
} from "./constants.js";

/**
 * Slot planning and grid layout for inventories. The server plans with what it reads inside
 * its transaction and the board plans with what it holds, so the same functions decide both.
 * The board's guess is then the server's answer unless another writer got there first.
 *
 * A stored card sits in one column and covers {@link cardSpan} rows downward from its slot,
 * enough to show its whole text. The slot is the index of its top cell.
 */

/** Where one card goes. */
export type SlotPlacement = { cardId: string; slot: number };

/** Where one card goes, with the inventory it goes into, as a stow answers. */
export type InventoryPlacement = SlotPlacement & { inventoryId: string };

/** A stored card's top cell and how many rows it covers. */
export type Footprint = { cardId: string; slot: number; span: number };

/** A card about to be placed, with the rows its text needs. */
export type Sized = { cardId: string; span: number };

// ── How many rows a card covers ─────────────────────────────────────────

/**
 * Average character width as a share of the font size. Monospace fonts run about 0.6 and
 * proportional ones narrower, so this overestimates the lines a text needs rather than
 * cutting it off. Text that still runs past its cells scrolls inside the card.
 */
const CHAR_WIDTH_EM = 0.62;
/** The card's 1px border, on both sides. */
const BORDER = 2;

/** Characters that fit across one cell. */
export const INVENTORY_LINE_CHARS = Math.floor(
  (INVENTORY_CELL.width - 2 * INVENTORY_CELL.paddingX - BORDER) /
    (INVENTORY_CELL.fontSize * CHAR_WIDTH_EM),
);

const LINE_PX = INVENTORY_CELL.fontSize * INVENTORY_CELL.lineHeight;

/** Lines of text a card covering `span` rows shows, gaps between its cells included. */
function linesShown(span: number): number {
  const { height, gap, paddingY } = INVENTORY_CELL;
  return Math.floor((span * height + (span - 1) * gap - 2 * paddingY - BORDER) / LINE_PX);
}

/**
 * How much of a card's text decides its span. Each line holds at most
 * {@link INVENTORY_LINE_CHARS} characters, so this many already reach the cap whatever
 * follows them. Readers that fetch text only to size cards fetch this much of it.
 */
export const INVENTORY_SPAN_SOURCE_CHARS =
  linesShown(INVENTORY_SPAN_MAX) * INVENTORY_LINE_CHARS + 1;

/**
 * Lines `content` wraps to at {@link INVENTORY_LINE_CHARS}, the way `pre-wrap` with
 * `break-word` lays it out: whole words where they fit, long words broken. Stops counting
 * at `cap`.
 */
function wrappedLines(content: string, cap: number): number {
  const width = INVENTORY_LINE_CHARS;
  let lines = 0;
  for (const paragraph of content.split("\n")) {
    let used = 0;
    lines++;
    for (const word of paragraph.split(" ")) {
      // A space before the word, unless it opens the line.
      const needed = used === 0 ? word.length : used + 1 + word.length;
      if (needed <= width) {
        used = needed;
        continue;
      }
      // It starts a line of its own, and a word longer than a line breaks across as many as
      // it fills, leaving the last one partly used.
      if (used > 0) lines++;
      const filled = Math.ceil(word.length / width);
      lines += filled - 1;
      used = word.length - (filled - 1) * width;
    }
    if (lines >= cap) return cap;
  }
  return lines;
}

/**
 * How many rows a stored card covers, from 1 to {@link INVENTORY_SPAN_MAX}, so its whole text
 * shows. Only the first {@link INVENTORY_SPAN_SOURCE_CHARS} characters matter.
 */
export function cardSpan(content: string): number {
  const needed = wrappedLines(content, linesShown(INVENTORY_SPAN_MAX) + 1);
  for (let span = 1; span < INVENTORY_SPAN_MAX; span++) if (linesShown(span) >= needed) return span;
  return INVENTORY_SPAN_MAX;
}

// ── Grid occupancy ──────────────────────────────────────────────────────

/** The cells a card covers, top to bottom. */
export function footprintCells(slot: number, span: number, columns = INVENTORY_COLUMNS): number[] {
  return Array.from({ length: span }, (_, row) => slot + row * columns);
}

/** The bottom cell a card covers, which is what a writer's slot cap is checked against. */
export function lastCell(slot: number, span: number, columns = INVENTORY_COLUMNS): number {
  return slot + (span - 1) * columns;
}

/** Which card covers which cell, for planning moves in one inventory. */
class Grid {
  readonly #byCell = new Map<number, string>();
  readonly #placed = new Map<string, { slot: number; span: number }>();

  constructor(held: readonly Footprint[]) {
    for (const { cardId, slot, span } of held) this.place(cardId, slot, span);
  }

  slotOf(cardId: string): number | undefined {
    return this.#placed.get(cardId)?.slot;
  }

  spanOf(cardId: string): number | undefined {
    return this.#placed.get(cardId)?.span;
  }

  place(cardId: string, slot: number, span: number): void {
    this.#placed.set(cardId, { slot, span });
    for (const cell of footprintCells(slot, span)) this.#byCell.set(cell, cardId);
  }

  remove(cardId: string): void {
    const at = this.#placed.get(cardId);
    if (!at) return;
    this.#placed.delete(cardId);
    for (const cell of footprintCells(at.slot, at.span)) this.#byCell.delete(cell);
  }

  /** The cards in the way of a card placed at `slot`, top cell first. */
  blockers(slot: number, span: number): string[] {
    const found = new Set<string>();
    for (const cell of footprintCells(slot, span)) {
      const cardId = this.#byCell.get(cell);
      if (cardId !== undefined) found.add(cardId);
    }
    return [...found].sort((a, b) => this.slotOf(a)! - this.slotOf(b)!);
  }

  fits(slot: number, span: number): boolean {
    return this.blockers(slot, span).length === 0;
  }

  /** The first slot at or after `from`, in reading order, where a card of `span` fits. */
  firstFit(span: number, from = 0): number {
    let slot = from;
    while (!this.fits(slot, span)) slot++;
    return slot;
  }
}

// ── Planning ────────────────────────────────────────────────────────────

/**
 * Plan where cards land when they are put into one inventory.
 *
 * `held` is what the inventory holds now. `target` is the slot they were dropped on, or null
 * to fill from the start.
 *
 * - One card dropped on a slot takes it. If exactly one card is in the way and the moving
 *   card came from this inventory, the two swap when each fits where the other was.
 *   Otherwise whatever is in the way moves to the first place it fits.
 * - Anything else goes, card by card, to the first place it fits from `target` onward.
 *   Cards already in this inventory stay where they are.
 *
 * Returns only the cards whose slot changes, displaced ones included.
 */
export function planStow(
  held: readonly Footprint[],
  moving: readonly Sized[],
  target: number | null,
): SlotPlacement[] {
  const unique = [...new Map(moving.map((m) => [m.cardId, m])).values()];
  const grid = new Grid(held);

  if (target !== null && unique.length === 1) {
    const [{ cardId, span }] = unique;
    const from = grid.slotOf(cardId);
    if (from === target) return [];
    grid.remove(cardId);
    const blockers = grid.blockers(target, span);
    if (blockers.length === 0) return [{ cardId, slot: target }];

    if (from !== undefined && blockers.length === 1) {
      const [other] = blockers;
      const otherSlot = grid.slotOf(other)!;
      const otherSpan = grid.spanOf(other)!;
      grid.remove(other);
      grid.place(cardId, target, span);
      if (grid.fits(from, otherSpan))
        return [
          { cardId, slot: target },
          { cardId: other, slot: from },
        ];
      grid.remove(cardId);
      grid.place(other, otherSlot, otherSpan);
    }

    const spans = new Map(blockers.map((id) => [id, grid.spanOf(id)!]));
    for (const id of blockers) grid.remove(id);
    grid.place(cardId, target, span);
    const plan = [{ cardId, slot: target }];
    for (const id of blockers) {
      const slot = grid.firstFit(spans.get(id)!);
      grid.place(id, slot, spans.get(id)!);
      plan.push({ cardId: id, slot });
    }
    return plan;
  }

  const plan: SlotPlacement[] = [];
  let next = target ?? 0;
  for (const { cardId, span } of unique) {
    if (grid.slotOf(cardId) !== undefined) continue;
    next = grid.firstFit(span, next);
    grid.place(cardId, next, span);
    plan.push({ cardId, slot: next });
  }
  return plan;
}

/**
 * Where a stored card goes after its text changed, which can make it cover more rows than
 * it did. It stays put if it still fits, and otherwise moves to the first place it fits.
 * `held` gives every card of the inventory, this one with its new span.
 */
export function planRefit(held: readonly Footprint[], cardId: string): SlotPlacement[] {
  const card = held.find((f) => f.cardId === cardId);
  if (!card) return [];
  const grid = new Grid(held.filter((f) => f.cardId !== cardId));
  if (grid.fits(card.slot, card.span)) return [];
  return [{ cardId, slot: grid.firstFit(card.span) }];
}

/** One inventory's cards as footprints, sized by their text. */
export function inventoryFootprints(
  cards: readonly {
    id: string;
    content: string;
    inventoryId: string | null;
    inventorySlot: number | null;
  }[],
  inventoryId: string,
): Footprint[] {
  return cards.flatMap((card) =>
    card.inventoryId === inventoryId && card.inventorySlot !== null
      ? [{ cardId: card.id, slot: card.inventorySlot, span: cardSpan(card.content) }]
      : [],
  );
}

// ── Layout ──────────────────────────────────────────────────────────────

/** Row and column of a slot, both counted from zero. */
export function slotCell(
  slot: number,
  columns = INVENTORY_COLUMNS,
): { row: number; column: number } {
  return { row: Math.floor(slot / columns), column: slot % columns };
}

/**
 * How many rows to draw. Always one empty row below the lowest card, so a full grid still
 * has somewhere to drop into, and never fewer than {@link INVENTORY_MIN_ROWS}.
 */
export function inventoryRows(
  footprints: Iterable<{ slot: number; span: number }>,
  columns = INVENTORY_COLUMNS,
  minRows = INVENTORY_MIN_ROWS,
): number {
  let bottom = -1;
  for (const { slot, span } of footprints)
    bottom = Math.max(bottom, Math.floor(slot / columns) + span - 1);
  return Math.max(minRows, bottom + 2);
}
