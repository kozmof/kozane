import { readRows, assemble } from "../../../services/snapshot.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import type { DB } from "$db/client";

import type { Namespace } from "$db/api/types";
import type { NamespaceDataSnapshot, TaskspaceFileTree, TaskspaceSummary } from "$lib/types";

import { getWorkspaceRoot } from "$db/internal/config";
import { resolveTaskspacePath } from "$lib/server/taskspace-path";
import { buildTaskspaceFileTreeOnce } from "$lib/server/taskspace-snapshot";

type LoadNamespaceSnapshot = {
  db: DB;
  namespaceId: string;
  /**
   * Whether to include local taskspace paths. Live boards use them to show directories.
   * Static exports null them to avoid publishing machine-specific paths.
   */
  includeTaskspacePaths: boolean;
  /**
   * Whether to fetch scopes, memberships, and taskspace summaries. Live boards include them.
   * Static exports omit them unless scoped files were requested, filtering server-side so
   * omitted details are absent from page data.
   */
  includeScopes: boolean;
  /**
   * Whether to embed taskspace file trees for static export. Require scope data too. Live
   * boards read files on demand and must not recursively scan directories during page loads
   * or polls.
   */
  includeScopedFiles: boolean;
};

/**
 * Load shared board data for page rendering and snapshot polling. Return null when the
 * namespace does not exist, leaving response handling to the caller.
 */
export async function loadNamespaceSnapshot({
  db,
  namespaceId,
  includeTaskspacePaths,
  includeScopes,
  includeScopedFiles,
}: LoadNamespaceSnapshot): Promise<{
  namespace: Namespace;
  snapshot: NamespaceDataSnapshot;
} | null> {
  // Read every table in one read transaction so the snapshot reflects a single committed
  // state. In WAL mode it sees one consistent view without taking the write lock. The
  // transaction holds one connection, which runs statements one at a time, so the reads
  // below are awaited in turn rather than through `Promise.all`.
  const rows = await readRows(db, workspaceServiceContext(), namespaceId, { includeScopes });
  if (!rows) return null;
  const { scopes, taskspaces } = rows;

  // For static export, include only taskspaces whose scopes appear in this snapshot. The
  // exported panel cannot reach other taskspaces, so publishing their names and files would
  // disclose unused data. Live snapshots retain the full visible taskspace set.
  const drawnScopes = new Set(scopes.map(({ id }) => id));
  const namedTaskspaces = includeScopedFiles
    ? taskspaces.filter(({ scopeId }) => scopeId !== null && drawnScopes.has(scopeId))
    : taskspaces;

  // Build file trees before removing local paths from exported rows. Reuse
  // `buildTaskspaceFileTreeOnce` so taskspaces shared across namespaces are walked only once
  // per build.
  let taskspaceFiles: Record<string, TaskspaceFileTree> | undefined;
  // Require scope data explicitly before embedding files so every tree has a corresponding
  // taskspace summary.
  if (includeScopedFiles && includeScopes) {
    const root = getWorkspaceRoot();
    if (root) {
      taskspaceFiles = {};
      for (const taskspace of namedTaskspaces) {
        if (!taskspace.path) continue;
        const baseDir = resolveTaskspacePath(taskspace.path, taskspace.pathKind, root);
        if (!baseDir) continue;
        taskspaceFiles[taskspace.id] = buildTaskspaceFileTreeOnce(baseDir);
      }
    }
  }

  return assemble(rows, {
    taskspaces: namedTaskspaces.map(
      ({ id, name, scopeId, path, pathKind }) =>
        ({
          id,
          name,
          scopeId,
          path: includeTaskspacePaths ? path : null,
          pathKind,
        }) satisfies TaskspaceSummary,
    ),
    taskspaceFiles,
  });
}
