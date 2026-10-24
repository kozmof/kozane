/**
 * Soft wrapping for the file editor. Break each line into visual rows that fit the panel,
 * counting cells the way a monospace font draws them: one for most characters, two for wide
 * East Asian characters and emoji, none for zero-width marks, and tab stops for tabs. Rows
 * break after whitespace when they can, and inside a word only when the word alone is wider
 * than a row.
 *
 * Columns are UTF-16 code units, as everywhere else in the editor. A row never splits a
 * grapheme cluster.
 */

/** Tab stop interval. The surface sets the same CSS `tab-size` so drawn tabs agree. */
export const TAB_SIZE = 8;

/** Where a visual row is: the line it belongs to and its position among that line's rows. */
export type RowRef = { line: number; index: number };

/** Row starts for a line that fits in one row. Shared because most lines are like this. */
const SINGLE_ROW: readonly number[] = Object.freeze([0]);

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Text that is only printable ASCII and tabs, where every code unit is its own grapheme. */
const ASCII = /^[\t\x20-\x7e]*$/;

/**
 * Hangul Jamo, CJK, Hangul syllables, compatibility forms, fullwidth forms, enclosed
 * ideographs, and planes 2 and 3.
 */
const WIDE =
  /^[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f200}-\u{1f2ff}\u{20000}-\u{3fffd}]/u;

const EMOJI = /\p{Emoji_Presentation}|\ufe0f/u;

const ZERO_WIDTH = /^[\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]+$/;

/** Cells one grapheme cluster takes in a monospace font. Tabs are handled by the caller. */
export function cellWidth(grapheme: string): number {
  // A cluster led by ASCII can still draw as an emoji, as a keycap like "1️⃣" does.
  if (grapheme.length === 1 && grapheme.charCodeAt(0) < 0x7f) return 1;
  if (WIDE.test(grapheme) || EMOJI.test(grapheme)) return 2;
  if (ZERO_WIDTH.test(grapheme)) return 0;
  return 1;
}

function* segments(text: string): Generator<[index: number, segment: string]> {
  if (ASCII.test(text)) {
    for (let i = 0; i < text.length; i++) yield [i, text[i]];
    return;
  }
  for (const { index, segment } of graphemes.segment(text)) yield [index, segment];
}

/**
 * Whether a row may break after `segment`. The ideographic space breaks like a space. A
 * no-break space does not, as its name says.
 */
function isBreakSpace(segment: string): boolean {
  return segment === " " || segment === "\t" || segment === "　";
}

/**
 * Whether `text` fits in `cols` without counting its cells. A grapheme is at least one code
 * unit and at most two cells, so a short line without tabs always fits.
 */
function surelyFits(text: string, cols: number): boolean {
  return text.length * 2 <= cols && !text.includes("\t");
}

/**
 * The columns where each visual row of `text` starts, beginning with 0. A line that fits, or
 * any line when `cols` is not a positive finite number, is one row.
 */
export function wrapLine(text: string, cols: number, tabSize = TAB_SIZE): readonly number[] {
  if (!(cols > 0 && Number.isFinite(cols))) return SINGLE_ROW;
  if (surelyFits(text, cols)) return SINGLE_ROW;

  const starts = [0];
  let rowStart = 0;
  let width = 0;
  // The column just after the row's last whitespace, and the row width up to it.
  let breakAt = -1;
  let widthAtBreak = 0;

  for (const [index, segment] of segments(text)) {
    const space = isBreakSpace(segment);
    const advance = () => (segment === "\t" ? tabSize - (width % tabSize) : cellWidth(segment));
    let w = advance();
    // Wrap the word in progress at the last whitespace, or here when there is none. A word
    // carried down may still not fit, so check again until it does or the row is empty.
    // Whitespace never wraps. It hangs past the row's end, so no row holds only spaces.
    if (!space) {
      while (width + w > cols && index > rowStart) {
        if (breakAt > rowStart) {
          // Subtracting is exact only because the word carried down holds no tab, whose
          // width would change with its new position. Tabs are break points, so it cannot.
          rowStart = breakAt;
          width -= widthAtBreak;
        } else {
          rowStart = index;
          width = 0;
        }
        starts.push(rowStart);
        breakAt = -1;
        w = advance();
      }
    }
    width += w;
    if (space) {
      breakAt = index + segment.length;
      widthAtBreak = width;
    }
  }
  return starts.length === 1 ? SINGLE_ROW : starts;
}

/**
 * The column of `text` between `from` and `to` whose left edge is nearest `cells` cells into
 * that row, counted as `wrapLine` counts them. For placing the caret on a row that is not
 * drawn and so cannot be measured.
 */
export function columnAtCell(
  text: string,
  from: number,
  to: number,
  cells: number,
  tabSize = TAB_SIZE,
): number {
  let width = 0;
  for (const [index, segment] of segments(text.slice(from, to))) {
    const w = segment === "\t" ? tabSize - (width % tabSize) : cellWidth(segment);
    if (width + w / 2 > cells) return from + index;
    width += w;
  }
  return to;
}

/**
 * Visual rows for a whole document. Lines map to a contiguous run of rows, so a row number
 * and a line position convert both ways with a prefix sum and a binary search.
 */
export class WrapLayout {
  readonly lineCount: number;
  readonly rowCount: number;
  /** Row starts per line, or undefined when no line wraps. */
  readonly #starts: (readonly number[])[] | undefined;
  /** First row of each line, plus the total at the end. Undefined when no line wraps. */
  readonly #firstRow: Int32Array | undefined;

  private constructor(lineCount: number, starts?: (readonly number[])[]) {
    this.lineCount = Math.max(1, lineCount);
    if (!starts || starts.every((rows) => rows.length === 1)) {
      this.rowCount = this.lineCount;
      return;
    }
    const firstRow = new Int32Array(starts.length + 1);
    for (let line = 0; line < starts.length; line++)
      firstRow[line + 1] = firstRow[line] + starts[line].length;
    this.#starts = starts;
    this.#firstRow = firstRow;
    this.rowCount = firstRow[starts.length];
  }

  /** One row per line, which is what an unmeasured or unbounded panel draws. */
  static unwrapped(lineCount: number): WrapLayout {
    return new WrapLayout(lineCount);
  }

  /** Rows for `lines`, each already split into its row starts. */
  static of(starts: (readonly number[])[]): WrapLayout {
    return new WrapLayout(starts.length, starts);
  }

  /** Row number of the line's first row. */
  firstRow(line: number): number {
    return this.#firstRow ? this.#firstRow[this.#clampLine(line)] : this.#clampLine(line);
  }

  rowStarts(line: number): readonly number[] {
    return this.#starts?.[this.#clampLine(line)] ?? SINGLE_ROW;
  }

  /**
   * Position among the line's rows of the row drawing `column`. A column at a wrap point
   * starts the next row, the same place the caret is drawn.
   */
  rowIndex(line: number, column: number): number {
    const starts = this.rowStarts(line);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid] <= column) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /** Row number drawing `column` of `line`. */
  rowOf(line: number, column: number): number {
    return this.firstRow(line) + this.rowIndex(line, column);
  }

  /** The line and row index drawn at row number `row`, clamped to the document. */
  rowAt(row: number): RowRef {
    const clamped = Math.min(Math.max(0, Math.floor(row)), this.rowCount - 1);
    const firstRow = this.#firstRow;
    if (!firstRow) return { line: clamped, index: 0 };
    let low = 0;
    let high = this.lineCount - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (firstRow[mid] <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low, index: clamped - firstRow[low] };
  }

  /** First column of the row after `index`, or null when `index` is the line's last row. */
  rowEnd(line: number, index: number): number | null {
    return this.rowStarts(line)[index + 1] ?? null;
  }

  #clampLine(line: number): number {
    return Math.min(Math.max(0, line), this.lineCount - 1);
  }
}

/** Matches every line break Reed recognizes, so split lines number the same as its lines. */
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Lay out documents at one row width, reusing the rows of lines whose text has not changed.
 * Create a new one when the width changes.
 */
export class LineWrapper {
  readonly cols: number;
  readonly tabSize: number;
  /**
   * Rows of the wrapping lines in the last layout. Each layout keeps only its own lines, so
   * the cache follows the document: an edit misses on the lines it changed and nothing else,
   * and lines no longer in the document are dropped.
   */
  #cache = new Map<string, readonly number[]>();

  constructor(cols: number, tabSize = TAB_SIZE) {
    this.cols = cols;
    this.tabSize = tabSize;
  }

  get wraps(): boolean {
    return this.cols > 0 && Number.isFinite(this.cols);
  }

  layout(text: string): WrapLayout {
    const lines = text.split(LINE_BREAK);
    if (!this.wraps) return WrapLayout.unwrapped(lines.length);
    const previous = this.#cache;
    this.#cache = new Map();
    return WrapLayout.of(lines.map((line) => this.#rows(line, previous)));
  }

  #rows(line: string, previous: Map<string, readonly number[]>): readonly number[] {
    if (surelyFits(line, this.cols)) return SINGLE_ROW;
    const rows =
      this.#cache.get(line) ?? previous.get(line) ?? wrapLine(line, this.cols, this.tabSize);
    this.#cache.set(line, rows);
    return rows;
  }
}
