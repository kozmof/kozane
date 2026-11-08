/** UTF-16 boundaries for whole grapheme clusters, cached by the current text of each line. */
export class GraphemeCache {
  #segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  #lines = new Map<number, { text: string; boundaries: number[] }>();

  boundaries(line: number, text: string): number[] {
    const cached = this.#lines.get(line);
    if (cached?.text === text) return cached.boundaries;
    const boundaries = [...this.#segmenter.segment(text)].map((segment) => segment.index);
    if (!boundaries.length || boundaries[boundaries.length - 1] !== text.length)
      boundaries.push(text.length);
    this.#lines.delete(line);
    this.#lines.set(line, { text, boundaries });
    if (this.#lines.size > 512) this.#lines.delete(this.#lines.keys().next().value!);
    return boundaries;
  }

  index(line: number, text: string, column: number): number {
    const boundaries = this.boundaries(line, text);
    const at = Math.min(text.length, Math.max(0, column));
    let low = 0,
      high = boundaries.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (boundaries[mid] <= at) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  snap(line: number, text: string, column: number): number {
    return this.boundaries(line, text)[this.index(line, text, column)];
  }

  clear(): void {
    this.#lines.clear();
  }
}
