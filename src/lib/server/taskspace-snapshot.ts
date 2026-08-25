import { TASKSPACE_SSG_DEPTH_MAX, TASKSPACE_SSG_TOTAL_BYTES_MAX } from "../constants.js";
import type { TaskspaceFileNode, TaskspaceFileTree } from "../types.js";
import { listTaskspaceDirectory, readTaskspaceFile, TaskspaceFilesError } from "./taskspace-files.js";

type DirectoryNode = Extract<TaskspaceFileNode, { kind: "directory" }>;

/**
 * Bytes left to embed in this taskspace's export, shared by reference across the whole
 * walk. A running total rather than a size computed up front: the live boundary functions
 * this reuses read one file at a time, so the only way to know a budget is exceeded is to
 * have been spending it as the walk goes.
 */
type Budget = { remaining: number };

function buildFileNode(
  baseDir: string,
  subPath: string,
  name: string,
  size: number | null,
  budget: Budget,
): TaskspaceFileNode {
  if (size !== null && size > budget.remaining) {
    return { kind: "file-skipped", name, reason: "budget", size };
  }

  try {
    const file = readTaskspaceFile({ baseDir, subPath });
    const bytes = Buffer.byteLength(file.content, "utf-8");
    if (bytes > budget.remaining) return { kind: "file-skipped", name, reason: "budget", size };
    budget.remaining -= bytes;
    return { kind: "file", name, content: file.content, size: bytes };
  } catch (e) {
    if (e instanceof TaskspaceFilesError && (e.reason === "too-large" || e.reason === "not-text")) {
      return { kind: "file-skipped", name, reason: e.reason, size };
    }
    // Permission denied, or the file was gone by the time this got to it — the listing
    // that named it ran moments earlier and is not a lease on what is still there.
    return { kind: "file-skipped", name, reason: "unreadable", size };
  }
}

function buildDirectoryNode(
  baseDir: string,
  subPath: string,
  name: string,
  budget: Budget,
  depth: number,
): DirectoryNode {
  // A backstop against a pathological real directory structure, not a limit anyone
  // browsing a normal project tree should ever reach. What is left unread here is still
  // reported as truncated, the same as a directory cut off by the entry-count cap.
  if (depth > TASKSPACE_SSG_DEPTH_MAX) return { kind: "directory", name, children: [], truncated: true };

  const listing = listTaskspaceDirectory({ baseDir, subPath });
  const children: TaskspaceFileNode[] = listing.entries.map((entry) => {
    const childPath = subPath ? `${subPath}/${entry.name}` : entry.name;
    switch (entry.kind) {
      case "directory":
        return buildDirectoryNode(baseDir, childPath, entry.name, budget, depth + 1);
      case "file":
        return buildFileNode(baseDir, childPath, entry.name, entry.size, budget);
      default:
        // A symlink is reported as itself and never followed, for the same reason the live
        // listing draws it that way rather than expanding it.
        return { kind: entry.kind, name: entry.name };
    }
  });

  return { kind: "directory", name, children, truncated: listing.truncated };
}

/**
 * Everything `kozane net ssg generate --include-scoped-files` bakes in for one taskspace:
 * its whole tree, file contents inline, within {@link TASKSPACE_SSG_TOTAL_BYTES_MAX} total.
 *
 * Built entirely on top of {@link listTaskspaceDirectory} and {@link readTaskspaceFile} —
 * the same boundary the live `/files` and `/file` endpoints hold a request to — so a static
 * export can walk no further into a taskspace than a browser tab already could, and every
 * rule that applies to a live read (dot-entries hidden, symlinks not followed, traversal
 * refused, the per-file size cap) applies here without being restated.
 */
export function buildTaskspaceFileTree(baseDir: string): TaskspaceFileTree {
  const budget: Budget = { remaining: TASKSPACE_SSG_TOTAL_BYTES_MAX };
  return { root: buildDirectoryNode(baseDir, "", "", budget, 0) };
}
