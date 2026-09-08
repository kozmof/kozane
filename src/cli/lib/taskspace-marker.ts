import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  TASKSPACE_MARKER_FILE,
  TASKSPACE_MARKER_KIND,
  TASKSPACE_MARKER_VERSION,
  TASKSPACE_MARKER_VERSION_1,
  type TaskspaceMarker,
} from "../../lib/taskspace-marker.js";

export type LocatedTaskspaceMarker = { marker: TaskspaceMarker; path: string };

export function readTaskspaceMarker(
  inputPath?: string,
  currentDir: string = process.cwd(),
): LocatedTaskspaceMarker | null {
  let markerPath: string;
  if (inputPath) {
    const target = resolve(currentDir, inputPath);
    if (!existsSync(target)) throw new Error(`Taskspace path not found: ${target}`);
    markerPath = statSync(target).isDirectory() ? join(target, TASKSPACE_MARKER_FILE) : target;
  } else {
    markerPath = join(currentDir, TASKSPACE_MARKER_FILE);
    if (!existsSync(markerPath)) return null;
  }

  if (!existsSync(markerPath)) throw new Error(`Taskspace marker not found: ${markerPath}`);
  if (basename(markerPath) !== TASKSPACE_MARKER_FILE)
    throw new Error(`Expected a ${TASKSPACE_MARKER_FILE} file: ${markerPath}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf-8"));
  } catch {
    throw new Error(`Invalid taskspace marker: ${markerPath}`);
  }
  // Named before the general check below, which would otherwise answer a marker written by
  // any earlier Kozane with "invalid" — it is not malformed, it is the previous format, and
  // the difference is the whole of what the reader can do about it.
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "kind" in parsed &&
    parsed.kind === TASKSPACE_MARKER_KIND &&
    "version" in parsed &&
    parsed.version === TASKSPACE_MARKER_VERSION_1
  ) {
    throw new Error(
      `Taskspace marker at ${markerPath} predates the rename of "project" to "namespace" ` +
        `and cannot be read. Delete it and recreate the taskspace with ` +
        `"kozane taskspace create".`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    parsed.kind !== TASKSPACE_MARKER_KIND ||
    !("version" in parsed) ||
    parsed.version !== TASKSPACE_MARKER_VERSION ||
    !("taskspaceId" in parsed) ||
    typeof parsed.taskspaceId !== "string" ||
    // Written as "" when the CLI creates a taskspace with no namespace attached.
    !("namespaceId" in parsed) ||
    typeof parsed.namespaceId !== "string"
  ) {
    throw new Error(`Invalid taskspace marker: ${markerPath}`);
  }
  return { marker: parsed as TaskspaceMarker, path: markerPath };
}
