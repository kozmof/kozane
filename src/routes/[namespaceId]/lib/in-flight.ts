/**
 * Count active edits and version every begin/end transition to protect them from snapshot
 * polling.
 *
 * Check both count and version because an edit can start and finish while a poll is in
 * flight, leaving the count at zero but its response stale. Keep these fields nonreactive
 * because they do not drive rendering.
 */
export class InFlight {
  #count = 0;
  #version = 0;

  begin(): void {
    this.#count += 1;
    this.#version += 1;
  }

  end(): void {
    // Clamp the count to zero so an unmatched `end` cannot hide later activity.
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
