import { withoutWarp, type WarpListEntry } from "$lib/warp-list";
import type { NamespaceState } from "../../../lib/client/board/namespace-state.svelte.js";
import type { BoardPoint } from "../../../lib/client/board/lib/canvas-viewport.js";
import type { KozaneBackend } from "$lib/backend/contract.js";
import { BackendError } from "$lib/backend/contract.js";
import { parseWarpEntries } from "$lib/backend/decoders/warp-directory.js";
import { ARROW_DIRECTIONS, warpInDirection } from "../../../lib/client/board/lib/namespace-page.js";
import type { NavigationAdapter } from "$lib/navigation.js";
import { reachableWarps } from "./warp-navigation.js";

/** The parts of the canvas warp navigation moves. */
export type WarpCanvas = {
  centerOn: (posX: number, posY: number) => void;
  getViewCenter: () => BoardPoint;
  isCenteredOn: (posX: number, posY: number) => boolean;
};

type BoardWarpsHost = {
  s: NamespaceState;
  navigation: () => NavigationAdapter;
  navigate: (href: string) => Promise<void>;
  backend: {
    warpDirectory: Pick<KozaneBackend["warpDirectory"], "get">;
    warps: Pick<KozaneBackend["warps"], "remove">;
  };
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
  #directoryRequest = 0;

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
    const { s, backend } = this.#host;
    const namespaceId = s.namespaceId;
    const request = ++this.#directoryRequest;
    try {
      const result = await backend.warpDirectory.get(namespaceId);
      if (request !== this.#directoryRequest || namespaceId !== s.namespaceId) return;
      const parsed = parseWarpEntries(result);
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
    void this.#host.navigate(this.#host.navigation().board(entry.namespaceId, { warp: entry.id }));
  }

  /**
   * Remove a warp through the palette, including warps in other namespaces. The `x` shortcut
   * affects only the focused marker on this board.
   */
  async remove(entry: WarpListEntry): Promise<void> {
    if (this.#host.readonly) return;
    const { s, backend } = this.#host;
    if (entry.namespaceId === s.namespaceId) {
      // Same path the `x` key takes, so one warp cannot be removed two different ways.
      await this.#host.removeWarp(entry.id);
      return;
    }
    await s.mutations.track(async () => {
      ++this.#directoryRequest;
      const previous = this.directory;
      this.directory = withoutWarp(this.directory, entry.id);
      try {
        await backend.warps.remove(entry.namespaceId, entry.id);
      } catch (error) {
        this.directory = previous;
        s.setError(error instanceof BackendError ? error.message : "Failed to remove warp");
      }
    });
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
