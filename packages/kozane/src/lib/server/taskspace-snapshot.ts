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
 * Remaining content-byte and entry budgets shared across the export walk. When bytes run out,
 * keep listing names. When entries run out, stop traversal.
 */
type Budget = { remaining: number; nodes: number };

/** Per-call limit overrides for testing. Production exports use the default constants. */
type BuildLimits = { bytes?: number; nodes?: number };

function buildFileNode(
  baseDir: string,
  subPath: string,
  name: string,
  size: number | null,
  budget: Budget,
): TaskspaceFileNode {
  // Check the per-file cap before the remaining byte budget so the reported reason identifies
  // the limit that would always exclude this file.
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
    // Handle files removed or made unreadable since the directory listing.
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
  // Stop at the depth limit and report truncation so the remaining subtree is not presented
  // as empty.
  if (depth > TASKSPACE_SSG_DEPTH_MAX)
    return { kind: "directory", name, children: [], truncated: "depth" };

  let listing;
  try {
    listing = listTaskspaceDirectory({ baseDir, subPath });
  } catch {
    // Skip and report unreadable subtrees, including a missing taskspace root, without
    // failing the entire prerender.
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
 * Build the taskspace tree and inline file contents for static export within content and
 * entry limits.
 *
 * Use the live directory and file readers to share path containment, hidden-file, symlink,
 * and file-size rules. Represent an unreadable root as an empty node marked unreadable.
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
 * Cache export trees by resolved directory so shared taskspaces are walked once across
 * prerendered pages. Treat cached trees as immutable.
 *
 * Use this entry point only for build-time reuse. Call `buildTaskspaceFileTree` directly when
 * later reads must observe filesystem changes.
 */
export function buildTaskspaceFileTreeOnce(baseDir: string): TaskspaceFileTree {
  const cached = treesByBaseDir.get(baseDir);
  if (cached) return cached;

  const tree = buildTaskspaceFileTree(baseDir);
  treesByBaseDir.set(baseDir, tree);
  return tree;
}

/** Clear memoized export trees between tests. */
export function clearTaskspaceFileTreeCache(): void {
  treesByBaseDir.clear();
}
