/** One durable layout intent covers direct and temporary directory locations. */
import { lstatSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { DB } from "../../db/database.js";
import { getTaskspace, updateTaskspace } from "../../db/api/taskspace.js";
import {
  enclosingTaskspaceDirs,
  holdsOtherTaskspaces,
  moveTaskspaceDirectory,
} from "../../lib/server/taskspace-directory.js";
import { getAllTaskspaces } from "../../db/api/taskspace.js";
import { errorCode, isStrictlyInside, sameEntry } from "../../lib/server/fs-paths.js";
import { TaskspaceFilesError } from "../../lib/server/taskspace-files.js";
import { taskspaceLayoutPaths } from "../../lib/server/taskspace-layout-paths.js";
import { journalTaskspaceDirectoryChange } from "../../lib/server/taskspace-service/directory-operation.js";
import type { LayoutMove } from "./taskspace-layout.js";
import { oneAtATime } from "../../lib/server/taskspace-service/queue.js";
import { directoryEvidence } from "../../lib/server/taskspace-directory-operations.js";

export function applyLayoutMove(
  db: DB,
  root: string,
  move: LayoutMove,
  pendingOwnedByBatch: ReadonlySet<string>,
) {
  return oneAtATime(move.taskspaceId, () =>
    moveLayoutDirectory(db, root, move, pendingOwnedByBatch),
  );
}

async function moveLayoutDirectory(
  db: DB,
  root: string,
  move: LayoutMove,
  pendingOwnedByBatch: ReadonlySet<string>,
) {
  const original = await getTaskspace({ db, taskspaceId: move.taskspaceId });
  if (
    !original ||
    !original.namespaceId ||
    original.pathKind !== "workspace_relative" ||
    original.path !== move.from
  )
    throw new TaskspaceFilesError(
      "stale",
      "Taskspace attachment changed since the layout was planned",
    );
  const target = resolve(root, move.to);
  if (!isStrictlyInside(resolve(root), target))
    throw new TaskspaceFilesError(
      "invalid-path",
      "Layout destination must stay inside the workspace",
    );
  const destination = relative(resolve(root), target);
  const paths = taskspaceLayoutPaths(root, move.from, destination, move.taskspaceId);
  // A known collision requires no filesystem callback. A nested target is freed by moving
  // its source aside, so only the temporary path can be checked before the first step.
  const first = resolve(root, paths[1]);
  try {
    if (!sameEntry(lstatSync(first), lstatSync(resolve(root, move.from))))
      throw new TaskspaceFilesError("exists", "A directory with that name already exists");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      if (paths.length === 3 && error instanceof TaskspaceFilesError && error.reason === "exists")
        throw new Error(
          `${paths[1]} already exists, and the move goes through it. Move it aside, then run kozane doctor --fix again`,
          { cause: error },
        );
      throw error;
    }
  }
  return journalTaskspaceDirectoryChange(
    {
      db,
      namespaceId: original.namespaceId,
      root,
      original,
      request: { operation: "layout", targetPath: destination },
      pendingOwnedByBatch,
      recheck: async () => {
        if (holdsOtherTaskspaces(root, original, await getAllTaskspaces({ db })))
          throw new TaskspaceFilesError("stale", "Taskspace directory now holds another taskspace");
      },
    },
    (identity) => {
      for (let index = 1; index < paths.length; index++) {
        const current = directoryEvidence(root, paths[index - 1], move.taskspaceId);
        if (
          current.state !== "owned" ||
          JSON.stringify(current.identity) !== JSON.stringify(identity)
        )
          throw new TaskspaceFilesError(
            "stale",
            "Taskspace directory changed during the layout move",
          );
        const from = resolve(root, paths[index - 1]);
        const enclosing = enclosingTaskspaceDirs(root, dirname(resolve(root, paths[index]))).find(
          (dir) => dir !== from,
        );
        if (enclosing)
          throw new TaskspaceFilesError(
            "invalid-path",
            `Layout target is inside the taskspace at ${relative(root, enclosing)}`,
          );
        moveTaskspaceDirectory({
          workspaceRoot: root,
          storedPath: paths[index - 1],
          nextStored: paths[index],
          taskspaceId: move.taskspaceId,
        });
      }
      return destination;
    },
    async (tx, nextPath) => {
      await updateTaskspace({ db: tx, taskspaceId: move.taskspaceId, path: nextPath });
    },
  );
}
