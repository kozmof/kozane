import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const WC_MARKER_DIR = ".kozane";
export const WC_MARKER_FILE = "working-copy.json";
export const WC_MARKER_KIND = "kozane.workingCopy";
export const WC_MARKER_VERSION = 1;

export type WcMarker = {
  kind: typeof WC_MARKER_KIND;
  version: number;
  workingCopyId: string;
  projectId: string;
};

export type FoundWorkingCopy = {
  workingCopyId: string;
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
    if (entry.startsWith(".") && entry !== ".kozane") continue; // skip hidden except our own
    try {
      if (statSync(fullPath).isDirectory()) {
        yield* walkDirectories(fullPath, depth + 1);
      }
    } catch {
      // skip unreadable entries
    }
  }
}

function readMarker(dir: string): WcMarker | null {
  const markerPath = join(dir, WC_MARKER_DIR, WC_MARKER_FILE);
  if (!existsSync(markerPath)) return null;
  try {
    const raw = readFileSync(markerPath, "utf-8");
    const marker = JSON.parse(raw) as WcMarker;
    if (marker.kind !== WC_MARKER_KIND) return null;
    if (marker.version !== WC_MARKER_VERSION) return null;
    return marker;
  } catch {
    return null;
  }
}

export function resolveWorkingCopyPath(
  storedPath: string,
  pathKind: "project_relative" | "absolute",
  projectRoot: string,
): string {
  return pathKind === "absolute" ? storedPath : join(projectRoot, storedPath);
}

export function scanWorkingCopies(searchRoots: string[]): FoundWorkingCopy[] {
  const found: FoundWorkingCopy[] = [];
  const seen = new Set<string>(); // deduplicate by workingCopyId+path

  for (const root of searchRoots) {
    for (const dir of walkDirectories(root)) {
      const marker = readMarker(dir);
      if (!marker) continue;

      const key = `${marker.workingCopyId}::${dir}`;
      if (seen.has(key)) continue;
      seen.add(key);

      found.push({
        workingCopyId: marker.workingCopyId,
        projectId: marker.projectId,
        path: dir,
      });
    }
  }

  return found;
}
