/**
 * Work in flight that a snapshot must not be applied over, counted and versioned.
 *
 * The board is polled once a second, and the answer describes the database as it was when
 * the request was made. Applying that over an edit the user has since started would undo
 * it on screen, so a poll stands down while anything is in flight.
 *
 * The count alone is not enough. A whole begin/end pair can land *while* a request is
 * outstanding — a card dropped and saved inside one second is exactly that — and by the
 * time the response arrives the count is back to zero, so the guard that stood down before
 * the request would wave the same stale snapshot through after it. {@link version} is what
 * closes that window: it moves on both begin and end and never moves back, so a caller
 * that noted it beforehand can tell "nothing happened" from "something happened and
 * finished".
 *
 * Deliberately plain fields rather than `$state`: nothing renders from these, and a rune
 * here would make every drag frame a reactive write for no reader.
 */
export class Activity {
  #count = 0;
  #version = 0;

  begin(): void {
    this.#count += 1;
    this.#version += 1;
  }

  end(): void {
    // Floored rather than allowed negative: an unbalanced `end` would otherwise leave the
    // count below zero and report the board as idle while a later `begin` is still open.
    this.#count = Math.max(0, this.#count - 1);
    this.#version += 1;
  }

  /** Runs `work` with the activity held open, however it finishes. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.begin();
    try {
      return await work();
    } finally {
      this.end();
    }
  }

  get idle(): boolean {
    return this.#count === 0;
  }

  get version(): number {
    return this.#version;
  }

  /** True when nothing has been started or finished since `version` was read, and none is open. */
  unchangedSince(version: number): boolean {
    return this.idle && this.#version === version;
  }
}
