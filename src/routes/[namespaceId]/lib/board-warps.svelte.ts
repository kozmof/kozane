import { goto } from "$app/navigation";
import { base } from "$app/paths";
import { page } from "$app/state";
import { withoutWarp, type WarpListEntry } from "$lib/warp-list";
import type { NamespaceState } from "../namespace-state.svelte.js";
import type { BoardPoint } from "./canvas-viewport.js";
import {
  deleteWarp,
  failureMessage,
  fetchWarpDirectory,
  parseWarpEntries,
} from "./namespace-api.js";
import { ARROW_DIRECTIONS, warpInDirection } from "./namespace-page.js";
import { crossNamespaceWarpHref, reachableWarps } from "./warp-navigation.js";

/** The parts of the canvas warp navigation moves. */
export type WarpCanvas = {
  centerOn: (posX: number, posY: number) => void;
  getViewCenter: () => BoardPoint;
  isCenteredOn: (posX: number, posY: number) => boolean;
};

type BoardWarpsHost = {
  s: NamespaceState;
  /** A static export has no endpoints, so it neither refreshes nor deletes. */
  readonly: boolean;
  /** Removes a warp on this board. The palette and the `x` key share it. */
  removeWarp: (warpId: string) => Promise<void>;
  /** Read on use, because the canvas mounts after this is built. */
  canvas: () => WarpCanvas;
};

/**
 * Warp markers on the board and the palette that lists every namespace's warps: whether
 * markers show, which warp is focused, jumping, removing, and arrow-key navigation.
 */
export class BoardWarps {
  readonly #host: BoardWarpsHost;

  /** Whether warp markers are drawn. */
  visible = $state(true);
  paletteOpen = $state(false);
  /**
   * Other namespaces' warps, loaded with the page and refreshed when the palette opens. Older
   * static exports may omit this directory.
   */
  directory = $state.raw<WarpListEntry[]>([]);

  constructor(host: BoardWarpsHost, initial: { visible: boolean; directory: WarpListEntry[] }) {
    this.#host = host;
    this.visible = initial.visible;
    this.directory = initial.directory;
  }

  /** Focus a warp and reveal its marker so the remove shortcut's target is visible. */
  focus(warpId: string): void {
    this.visible = true;
    this.#host.s.focusedWarpId = warpId;
  }

  openPalette(): void {
    this.paletteOpen = true;
    void this.refreshDirectory();
  }

  /** Refresh the palette with warps added by another tab or the CLI. */
  async refreshDirectory(): Promise<void> {
    // A static export has no endpoint to ask, and nothing can have changed under it.
    if (this.#host.readonly) return;
    const { s } = this.#host;
    try {
      const res = await fetchWarpDirectory(s.fetcher, s.namespaceId);
      if (!res.ok) return;
      const parsed = parseWarpEntries(await res.json().catch(() => null));
      // An answer that is not a list of rows is treated as no answer at all.
      if (parsed) this.directory = parsed;
    } catch {
      // Keep the copy that came with the page, because a stale list beats an empty one.
    }
  }

  jump(entry: WarpListEntry): void {
    this.paletteOpen = false;
    if (entry.namespaceId === this.#host.s.namespaceId) {
      this.#host.canvas().centerOn(entry.posX, entry.posY);
      this.focus(entry.id);
      return;
    }
    void goto(crossNamespaceWarpHref(base, page.url.pathname, entry));
  }

  /**
   * Remove a warp through the palette, including warps in other namespaces. The `x` shortcut
   * affects only the focused marker on this board.
   */
  async remove(entry: WarpListEntry): Promise<void> {
    const { s } = this.#host;
    if (entry.namespaceId === s.namespaceId) {
      // Same path the `x` key takes, so one warp cannot be removed two different ways.
      await this.#host.removeWarp(entry.id);
      return;
    }
    const previous = this.directory;
    this.directory = withoutWarp(this.directory, entry.id);
    const res = await deleteWarp(s.mutationFetcher, entry.namespaceId, entry.id);
    if (!res.ok) {
      this.directory = previous;
      s.setError(await failureMessage(res, "Failed to remove warp"));
    }
  }

  /** Center on a warp in the arrow key's direction and return whether one was found. */
  toward(key: string): boolean {
    const { s } = this.#host;
    const canvas = this.#host.canvas();
    // Measured from where the view is now, so warping works the same whether you arrived
    // by arrow key or by dragging the canvas.
    const { posX, posY } = canvas.getViewCenter();
    const target = warpInDirection(
      reachableWarps(s.warps, s.focusedWarpId, (x, y) => canvas.isCenteredOn(x, y)),
      { x: posX, y: posY },
      ARROW_DIRECTIONS[key],
      s.focusedWarpId,
    );
    if (!target) return false;
    canvas.centerOn(target.posX, target.posY);
    this.focus(target.id);
    return true;
  }
}
