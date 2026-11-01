import type { WorldRect } from "./namespace-page.js";

type ScopeAreaInput = { posX: number; posY: number; width: number; height: number };

type PendingFrameHost = {
  /** Cards the drawn board shows inside a world rectangle. */
  cardIdsIn: (rect: WorldRect) => string[];
  addToScope: (scopeId: string, area: ScopeAreaInput, covers: string[]) => Promise<unknown>;
  addToNewScope: (name: string, area: ScopeAreaInput, covers: string[]) => Promise<unknown>;
};

/** The drawn rectangle as the API takes it. */
function asArea(rect: WorldRect): ScopeAreaInput {
  return { posX: rect.x, posY: rect.y, width: rect.w, height: rect.h };
}

/**
 * An Alt-drawn rectangle awaiting a scope. The canvas sets `rect` on release, and the scope
 * prompt's answer turns it into a frame or drops it.
 */
export class PendingFrame {
  readonly #host: PendingFrameHost;

  rect = $state<WorldRect | null>(null);
  /**
   * Card count measured when the rectangle is drawn, for display in the prompt. The answer
   * measures again, to account for changes while the prompt was open.
   */
  cardCount = $state(0);

  constructor(host: PendingFrameHost) {
    this.#host = host;
  }

  /** Measure the rectangle for the prompt. The page calls this after the board is drawn. */
  measure(): void {
    const rect = this.rect;
    this.cardCount = rect ? this.#host.cardIdsIn(rect).length : 0;
  }

  cancel(): void {
    this.rect = null;
  }

  async chooseScope(scopeId: string): Promise<void> {
    const taken = this.#take();
    if (taken) await this.#host.addToScope(scopeId, taken.area, taken.covers);
  }

  async createScope(name: string): Promise<void> {
    const taken = this.#take();
    if (taken) await this.#host.addToNewScope(name, taken.area, taken.covers);
  }

  /** Measure again, because polling may have changed the board, then clear the rectangle. */
  #take(): { area: ScopeAreaInput; covers: string[] } | null {
    const rect = this.rect;
    if (!rect) return null;
    const covers = this.#host.cardIdsIn(rect);
    this.rect = null;
    return { area: asArea(rect), covers };
  }
}
