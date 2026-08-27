import {
  TASKSPACE_FILE_BYTES_MAX,
  TASKSPACE_SSG_DEPTH_MAX,
  TASKSPACE_SSG_NODES_MAX,
  TASKSPACE_SSG_TOTAL_BYTES_MAX,
} from "../constants.js";
import type { TaskspaceFileNode, TaskspaceFileTree, TaskspaceTruncation } from "../types.js";
import {
  listTaskspaceDirectory,
  readTaskspaceFile,
  TaskspaceFilesError,
} from "./taskspace-files.js";

type DirectoryNode = Extract<TaskspaceFileNode, { kind: "directory" }>;

/**
 * What is left to spend on this taskspace's export, shared by reference across the whole
 * walk: bytes of file content, and entries of tree. Running totals rather than sizes
 * computed up front — the live boundary functions this reuses read one directory and one
 * file at a time, so the only way to know a budget is exceeded is to have been spending it
 * as the walk goes.
 *
 * The two run out differently on purpose. Out of bytes, the walk carries on and lists what
 * it finds by name, so the tree still shows what is there; out of entries, there is nothing
 * left to say a name in, and the walk stops.
 */
type Budget = { remaining: number; nodes: number };

/**
 * Ceilings for one call, each defaulting to the constant it is named after. Overridable so
 * a test can reach a limit without putting fifty thousand entries on disk to do it — the
 * export itself has no reason to pass either, and does not.
 */
type BuildLimits = { bytes?: number; nodes?: number };

function buildFileNode(
  baseDir: string,
  subPath: string,
  name: string,
  size: number | null,
  budget: Budget,
): TaskspaceFileNode {
  // The per-file cap is asked about first, and deliberately: a file over it is withheld at
  // any budget, so reporting a low budget for it would name a limit that is not the one
  // keeping it out. Below the cap, the budget is the honest answer — and settling it here
  // also spares a read of a file that is only going to be refused.
  if (size !== null && size > TASKSPACE_FILE_BYTES_MAX) {
    return { kind: "file-skipped", name, reason: "too-large", size };
  }
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
  // reported as truncated, the same as a directory cut off by any other limit — under its
  // own reason, so the panel does not call a directory this stopped at "empty".
  if (depth > TASKSPACE_SSG_DEPTH_MAX)
    return { kind: "directory", name, children: [], truncated: "depth" };

  let listing;
  try {
    listing = listTaskspaceDirectory({ baseDir, subPath });
  } catch {
    // The same degrade-and-carry-on `buildFileNode` does, for the same reasons — a
    // directory the build user cannot read, or one gone since the listing that named it —
    // plus the taskspace root itself no longer resolving, which reaches this as the first
    // call of the walk. An export skips the subtree it could not read and says so; it does
    // not fail the whole prerender over one directory, which is what letting a
    // `TaskspaceFilesError` past here would do.
    return { kind: "directory", name, children: [], truncated: "unreadable" };
  }

  const children: TaskspaceFileNode[] = [];
  let truncated: TaskspaceTruncation | null = listing.truncated ? "entries" : null;
  for (const entry of listing.entries) {
    if (budget.nodes <= 0) {
      truncated = "nodes";
      break;
    }
    budget.nodes -= 1;
    const childPath = subPath ? `${subPath}/${entry.name}` : entry.name;
    switch (entry.kind) {
      case "directory":
        children.push(buildDirectoryNode(baseDir, childPath, entry.name, budget, depth + 1));
        break;
      case "file":
        children.push(buildFileNode(baseDir, childPath, entry.name, entry.size, budget));
        break;
      default:
        // A symlink is reported as itself and never followed, for the same reason the live
        // listing draws it that way rather than expanding it.
        children.push({ kind: entry.kind, name: entry.name });
    }
  }

  return { kind: "directory", name, children, truncated };
}

/**
 * Everything `kozane net ssg generate --include-scoped-files` bakes in for one taskspace:
 * its whole tree, file contents inline, within {@link TASKSPACE_SSG_TOTAL_BYTES_MAX} of
 * content across at most {@link TASKSPACE_SSG_NODES_MAX} entries.
 *
 * Built entirely on top of {@link listTaskspaceDirectory} and {@link readTaskspaceFile} —
 * the same boundary the live `/files` and `/file` endpoints hold a request to — so a static
 * export can walk no further into a taskspace than a browser tab already could, and every
 * rule that applies to a live read (dot-entries hidden, symlinks not followed, traversal
 * refused, the per-file size cap) applies here without being restated.
 *
 * Never throws: a taskspace whose directory has been deleted, moved, or made unreadable
 * since the row naming it was written comes back as an empty root marked `"unreadable"`,
 * because one such taskspace must not take the export down with it.
 */
export function buildTaskspaceFileTree(
  baseDir: string,
  limits: BuildLimits = {},
): TaskspaceFileTree {
  const budget: Budget = {
    remaining: limits.bytes ?? TASKSPACE_SSG_TOTAL_BYTES_MAX,
    nodes: limits.nodes ?? TASKSPACE_SSG_NODES_MAX,
  };
  return { root: buildDirectoryNode(baseDir, "", "", budget, 0) };
}

/**
 * Trees already walked in this process, by the directory they were walked from. Only ever
 * written by {@link buildTaskspaceFileTreeOnce}, so nothing populates it outside a static
 * export.
 */
const treesByBaseDir = new Map<string, TaskspaceFileTree>();

/**
 * {@link buildTaskspaceFileTree}, but walking each directory once however many pages of an
 * export end up carrying it.
 *
 * A taskspace with no `project_id` is unplaced rather than another project's, so every
 * project's board draws it (see `getTaskspacesInProject`) and every project's page therefore
 * embeds its files. Walked afresh per page, one such taskspace over a workspace of five
 * projects is five full recursive passes over the same unchanged directory — up to five
 * times {@link TASKSPACE_SSG_NODES_MAX} `lstat` calls and five reads of every file — to
 * produce five trees that cannot differ, because a prerender reads a filesystem nobody is
 * writing to. Two taskspace rows pointed at the same directory collapse the same way, which
 * is why this is keyed by the resolved path rather than by taskspace id.
 *
 * Callers share one tree object rather than each getting their own. Nothing mutates a tree
 * after it is built, and each page serializes its own copy into its own output, so what is
 * shared is the walk and the memory holding the result — not anything a page could change
 * out from under another.
 *
 * Deliberately a separate entry point rather than caching inside `buildTaskspaceFileTree`:
 * caching there would make a second call answer about a directory as it used to be, which is
 * wrong for every caller reading a filesystem still being written to — the live server if it
 * ever walks one, and the tests that write a file and walk again to see it.
 */
export function buildTaskspaceFileTreeOnce(baseDir: string): TaskspaceFileTree {
  const cached = treesByBaseDir.get(baseDir);
  if (cached) return cached;

  const tree = buildTaskspaceFileTree(baseDir);
  treesByBaseDir.set(baseDir, tree);
  return tree;
}

/**
 * Forgets every memoized tree. For tests, which walk a temporary directory, delete it, and
 * walk a fresh one at a path the first may well have used — a build runs once and exits.
 */
export function clearTaskspaceFileTreeCache(): void {
  treesByBaseDir.clear();
}
