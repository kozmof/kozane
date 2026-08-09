import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  TASKSPACE_MARKER_FILE,
  TASKSPACE_MARKER_KIND,
  TASKSPACE_MARKER_VERSION,
  type TaskspaceMarker,
} from "../../lib/taskspace-marker.js";
import { readTaskspaceMarker } from "./taskspace-marker.js";

export {
  TASKSPACE_MARKER_FILE,
  TASKSPACE_MARKER_KIND,
  TASKSPACE_MARKER_VERSION,
  type TaskspaceMarker,
};

export type FoundTaskspace = {
  taskspaceId: string;
  projectId: string;
  path: string;
};

function* walkDirectories(root: string, depth = 0): Generator<string> {
  if (depth > 5) return; // guard against deep trees
  if (!existsSync(root)) return;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  // Yield the root itself first so we check it too
  yield root;

  for (const entry of entries) {
    const fullPath = join(root, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue; // skip unreadable entries
    }
    if (entry.startsWith(".")) {
      // Check for a marker file but do not recurse — avoids descending into .git, .kozane, etc.
      yield fullPath;
      continue;
    }
    yield* walkDirectories(fullPath, depth + 1);
  }
}

/**
 * Scanning treats an unreadable or foreign marker as "no taskspace here" rather than
 * an error, but validates it exactly as `kozane card list` does.
 */
function readMarker(dir: string): TaskspaceMarker | null {
  if (!existsSync(join(dir, TASKSPACE_MARKER_FILE))) return null;
  try {
    return readTaskspaceMarker(dir)?.marker ?? null;
  } catch {
    return null;
  }
}

export function resolveTaskspacePath(
  storedPath: string,
  pathKind: "project_relative" | "absolute",
  projectRoot: string,
): string {
  return pathKind === "absolute" ? storedPath : join(projectRoot, storedPath);
}

export type TaskspaceRecord = {
  id: string;
  name: string | null;
  path: string | null;
  pathKind: "project_relative" | "absolute";
};

export type TaskspaceDiff = {
  missing: TaskspaceRecord[];
  moved: Array<{ record: TaskspaceRecord; scanned: FoundTaskspace }>;
  orphans: FoundTaskspace[];
};

export function diffTaskspaces(
  found: FoundTaskspace[],
  dbRecords: TaskspaceRecord[],
  projectRoot: string,
): TaskspaceDiff {
  const foundById = new Map(found.map((f) => [f.taskspaceId, f]));
  const dbIds = new Set(dbRecords.map((r) => r.id));
  const missing: TaskspaceRecord[] = [];
  const moved: Array<{ record: TaskspaceRecord; scanned: FoundTaskspace }> = [];
  const orphans: FoundTaskspace[] = [];

  for (const record of dbRecords) {
    const scanned = foundById.get(record.id);
    if (!scanned) {
      missing.push(record);
    } else {
      const resolvedStored = record.path
        ? resolveTaskspacePath(record.path, record.pathKind, projectRoot)
        : null;
      if (resolvedStored !== scanned.path) moved.push({ record, scanned });
    }
  }

  for (const taskspace of found) {
    if (!dbIds.has(taskspace.taskspaceId)) orphans.push(taskspace);
  }

  return { missing, moved, orphans };
}

export function scanTaskspaces(searchRoots: string[]): FoundTaskspace[] {
  const found: FoundTaskspace[] = [];
  const seen = new Set<string>(); // deduplicate by taskspaceId+path

  for (const root of searchRoots) {
    for (const dir of walkDirectories(root)) {
      const marker = readMarker(dir);
      if (!marker) continue;

      const key = `${marker.taskspaceId}::${dir}`;
      if (seen.has(key)) continue;
      seen.add(key);

      found.push({
        taskspaceId: marker.taskspaceId,
        projectId: marker.projectId,
        path: dir,
      });
    }
  }

  return found;
}
