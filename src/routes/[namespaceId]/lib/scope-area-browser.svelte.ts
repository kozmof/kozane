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

/** Read current board props through getters. */
export type ScopeAreaBrowserSource = {
  areas: () => ScopeArea[];
  taskspaces: () => TaskspaceSummary[];
  tree: () => TaskspaceTreeState;
  context: () => TaskspaceTreeContext;
};

/**
 * Track the displayed taskspace directory separately for each scope frame. Do not persist
 * navigation across board reloads. The component owns loading and pruning effects, while
 * `scope-area-files.ts` provides layout calculations.
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
   * Deduplicate directory requests by taskspace and path across frames. Separate key parts
   * with NUL, which paths cannot contain. Read only frame identity and scope so dragging
   * geometry does not retrigger loading.
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
