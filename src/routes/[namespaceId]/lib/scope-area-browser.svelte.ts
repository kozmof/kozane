import type { ScopeArea, TaskspaceSummary } from "$lib/types";
import type { TaskspaceTreeContext, TaskspaceTreeState } from "./taskspace-tree.svelte.js";
import {
  cwdFor,
  cwdKey,
  fileGroupsForArea,
  pruneCwd,
  taskspacesForScope,
  type FileGroup,
} from "./scope-area-files.js";

/** What the browser reads from the board, as getters: every one of them is a prop. */
export type ScopeAreaBrowserSource = {
  areas: () => ScopeArea[];
  taskspaces: () => TaskspaceSummary[];
  tree: () => TaskspaceTreeState;
  context: () => TaskspaceTreeContext;
};

/**
 * The file icons drawn under each scope frame, and which directory each frame is showing.
 *
 * Per frame rather than per scope: a scope framed in two places gets its icons under both,
 * and drilling into a folder on one leaves the other where it was. The same answer the
 * frame's own `×` gives to "which one did you mean".
 *
 * Local to the board and deliberately not persisted. Where a frame is looking is a way of
 * looking at it rather than anything about the board, and a folder left open across a reload
 * would be a frame whose icons do not match the taskspace it names.
 *
 * The layout arithmetic is `scope-area-files.ts`; this is the one piece of state it reads.
 * The board owns the two effects that act on it — reading what is shown and pruning what is
 * gone — so they run in the component's lifetime rather than a class's.
 */
export class ScopeAreaBrowser {
  /** Which directory each frame is showing of each taskspace, by `cwdKey`. Absent is the root. */
  #cwd = $state<Record<string, string>>({});
  readonly #source: ScopeAreaBrowserSource;

  constructor(source: ScopeAreaBrowserSource) {
    this.#source = source;
  }

  /** Each frame with the board's taskspaces that belong to its scope. */
  #framed = $derived.by(() =>
    this.#source.areas().map((area) => ({
      area,
      taskspaces: taskspacesForScope(
        this.#source.taskspaces(),
        area.scopeId,
        this.#source.context().staticFiles,
      ),
    })),
  );

  /** The icon groups each frame draws, by frame id. */
  readonly fileGroupsByArea: Map<string, FileGroup[]> = $derived.by(
    () =>
      new Map(
        this.#framed.map(({ area, taskspaces }) => [
          area.id,
          fileGroupsForArea({
            areaId: area.id,
            taskspaces,
            cwdByKey: this.#cwd,
            nodeOf: (taskspaceId, path) => this.#source.tree().node(taskspaceId, path),
          }),
        ]),
      ),
  );

  /**
   * What the frames between them need read off disk: one directory per frame per taskspace,
   * each named once however many frames are showing it.
   *
   * Deduplicated because the cache is keyed by taskspace and path and not by frame, so two
   * frames of one scope showing the same folder are one request. The key is joined on a NUL,
   * the one byte a path cannot contain — any printable separator could collide.
   *
   * Reads only `area.id` and `area.scopeId`, never a rectangle, so a frame being dragged —
   * whose position is written on every pointer move — does not recompute this.
   */
  readonly directoriesToRead: { taskspaceId: string; path: string }[] = $derived.by(() => {
    const seen = new Set<string>();
    const wanted: { taskspaceId: string; path: string }[] = [];
    for (const { area, taskspaces } of this.#framed) {
      for (const taskspace of taskspaces) {
        const path = cwdFor(this.#cwd, area.id, taskspace.id);
        const key = `${taskspace.id}\0${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        wanted.push({ taskspaceId: taskspace.id, path });
      }
    }
    return wanted;
  });

  /** Asks the shared tree cache for every directory a frame is showing. */
  readShown(): void {
    const tree = this.#source.tree();
    const context = this.#source.context();
    for (const { taskspaceId, path } of this.directoriesToRead) {
      tree.ensure(context, taskspaceId, path);
    }
  }

  /** Forgets where a frame was looking once the frame, or the taskspace, is gone. */
  prune(): void {
    const next = pruneCwd(
      this.#cwd,
      this.#source.areas().map((a) => a.id),
      this.#source.taskspaces().map((t) => t.id),
    );
    if (Object.keys(next).length !== Object.keys(this.#cwd).length) this.#cwd = next;
  }

  navigate(areaId: string, taskspaceId: string, path: string): void {
    this.#cwd = { ...this.#cwd, [cwdKey(areaId, taskspaceId)]: path };
  }
}
