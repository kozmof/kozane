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

/**
 * A card leaving its inventory, and where on the canvas it goes: both coordinates, or neither
 * to go back where it was before it was stored.
 */
export type TakenCard = { cardId: string } | { cardId: string; posX: number; posY: number };

// ── How many rows a card covers ─────────────────────────────────────────

/*
 * Widths are counted in hundredths of the font size, so the model stays in integers.
 *
 * A narrow character is taken as 0.62em. Monospace fonts run about 0.6 and proportional ones
 * narrower, so this overestimates the lines a text needs rather than cutting it off. East
 * Asian wide characters take a full 1em. Text that still runs past its cells scrolls inside
 * the card.
 */
const NARROW = 62;
const WIDE = 100;
/** The card's 1px border, on both sides. */
const BORDER = 2;

/** Width across one cell's text, in hundredths of the font size. */
const LINE_WIDTH = Math.floor(
  ((INVENTORY_CELL.width - 2 * INVENTORY_CELL.paddingX - BORDER) * 100) / INVENTORY_CELL.fontSize,
);

/** Narrow characters that fit across one cell. */
export const INVENTORY_LINE_CHARS = Math.floor(LINE_WIDTH / NARROW);

const LINE_PX = INVENTORY_CELL.fontSize * INVENTORY_CELL.lineHeight;

/** Lines of text a card covering `span` rows shows, gaps between its cells included. */
function linesShown(span: number): number {
  const { height, gap, paddingY } = INVENTORY_CELL;
  return Math.floor((span * height + (span - 1) * gap - 2 * paddingY - BORDER) / LINE_PX);
}

/** Lines {@link wrappedLines} stops counting at, one more than the tallest card shows. */
const LINES_CAP = linesShown(INVENTORY_SPAN_MAX) + 1;

/**
 * How much of a card's text decides its span, in code points, as SQLite's `substr` counts.
 * Every code point takes at least {@link NARROW} of a line, so a line holds at most
 * {@link INVENTORY_LINE_CHARS} of them plus the line break that ends it. This many therefore
 * reach {@link LINES_CAP}, and since more text never wraps to fewer lines, the rest cannot
 * change the span. Readers that fetch text only to size cards fetch this much of it.
 */
export const INVENTORY_SPAN_SOURCE_CHARS = LINES_CAP * (INVENTORY_LINE_CHARS + 1);

/**
 * Hangul, CJK, kana, fullwidth forms, and the emoji blocks. Close enough to Unicode's East
 * Asian Wide and Fullwidth classes for sizing a card.
 */
const WIDE_CHAR =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;

/**
 * Lines `content` wraps to, the way the stored card's `break-spaces` with `break-word` lays it
 * out: whole words where they fit, long words broken, and every space taking its width and
 * wrapping like a character. A space and a wide character each end a word, since a line can
 * break after either. Stops counting at {@link LINES_CAP}.
 */
function wrappedLines(content: string): number {
  let lines = 0;
  for (const paragraph of content.split("\n")) {
    lines++;
    let used = 0;
    let word = 0;
    /** Places the pending word, breaking it across lines when it is wider than one. */
    const flush = () => {
      if (word === 0) return;
      if (used > 0 && used + word > LINE_WIDTH) {
        lines++;
        used = 0;
      }
      while (used + word > LINE_WIDTH) {
        // Only a word wider than a whole line gets here. It fills the line it is on.
        const fits = Math.floor((LINE_WIDTH - used) / NARROW) * NARROW;
        word -= fits;
        lines++;
        used = 0;
      }
      used += word;
      word = 0;
    };
    /** Places one unbreakable piece, a space or a wide character, after the pending word. */
    const place = (width: number) => {
      flush();
      if (used + width > LINE_WIDTH) {
        lines++;
        used = 0;
      }
      used += width;
    };
    for (const char of paragraph) {
      if (char === " ") place(NARROW);
      else if (WIDE_CHAR.test(char)) place(WIDE);
      else word += NARROW;
      if (lines >= LINES_CAP) return LINES_CAP;
    }
    flush();
    if (lines >= LINES_CAP) return LINES_CAP;
  }
  return lines;
}

/**
 * How many rows a stored card covers, from 1 to {@link INVENTORY_SPAN_MAX}, so its whole text
 * shows. Only the first {@link INVENTORY_SPAN_SOURCE_CHARS} code points matter.
 */
export function cardSpan(content: string): number {
  const needed = wrappedLines(content);
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

/**
 * Cards that cover a cell another card of the same inventory covers. Writers never leave this,
 * but spans come from text and from the layout constants, so a release that changes the
 * layout, or an imported dump, can. Each conflicting card is named once.
 */
export function overlappingCards(held: readonly Footprint[]): string[] {
  const byCell = new Map<number, string>();
  const found = new Set<string>();
  for (const { cardId, slot, span } of held)
    for (const cell of footprintCells(slot, span)) {
      const other = byCell.get(cell);
      if (other === undefined) byCell.set(cell, cardId);
      else found.add(other).add(cardId);
    }
  return [...found];
}

/**
 * Where cards go so that none overlaps another, for an inventory left overlapping (see
 * {@link overlappingCards}). Cards are taken in reading order of their top cells. Each stays
 * put if it still fits, and otherwise moves to the first place it fits at or after its slot,
 * so the grid keeps its order. Returns only the cards that move.
 */
export function planRepair(held: readonly Footprint[]): SlotPlacement[] {
  const ordered = held.toSorted((a, b) => a.slot - b.slot || (a.cardId < b.cardId ? -1 : 1));
  const grid = new Grid([]);
  const plan: SlotPlacement[] = [];
  for (const { cardId, slot, span } of ordered) {
    const at = grid.firstFit(span, slot);
    grid.place(cardId, at, span);
    if (at !== slot) plan.push({ cardId, slot: at });
  }
  return plan;
}

/** One inventory's cards as footprints, sized by their text. */
export function inventoryFootprints(
  cards: readonly {
    id: string;
    content: string;
    inventory: { id: string; slot: number } | null;
  }[],
  inventoryId: string,
): Footprint[] {
  return cards.flatMap(({ id, content, inventory }) =>
    inventory?.id === inventoryId
      ? [{ cardId: id, slot: inventory.slot, span: cardSpan(content) }]
      : [],
  );
}

/**
 * The cards stored in some inventory. A selection can reach into an inventory, so actions that
 * only make sense on the canvas, such as dragging or gluing, leave these out.
 */
export function storedCardIds(
  cards: Iterable<{ id: string; inventory: { id: string } | null }>,
): Set<string> {
  const stored = new Set<string>();
  for (const { id, inventory } of cards) if (inventory !== null) stored.add(id);
  return stored;
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
