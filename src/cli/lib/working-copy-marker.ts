import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  WC_MARKER_FILE,
  WC_MARKER_KIND,
  WC_MARKER_VERSION,
  type WcMarker,
} from "../../lib/wc-marker.js";

export type LocatedWorkingCopyMarker = { marker: WcMarker; path: string };

export function readWorkingCopyMarker(
  inputPath?: string,
  currentDir: string = process.cwd(),
): LocatedWorkingCopyMarker | null {
  let markerPath: string;
  if (inputPath) {
    const target = resolve(currentDir, inputPath);
    if (!existsSync(target)) throw new Error(`Working-copy path not found: ${target}`);
    markerPath = statSync(target).isDirectory() ? join(target, WC_MARKER_FILE) : target;
  } else {
    markerPath = join(currentDir, WC_MARKER_FILE);
    if (!existsSync(markerPath)) return null;
  }

  if (!existsSync(markerPath)) throw new Error(`Working-copy marker not found: ${markerPath}`);
  if (basename(markerPath) !== WC_MARKER_FILE)
    throw new Error(`Expected a ${WC_MARKER_FILE} file: ${markerPath}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf-8"));
  } catch {
    throw new Error(`Invalid working-copy marker: ${markerPath}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    parsed.kind !== WC_MARKER_KIND ||
    !("version" in parsed) ||
    parsed.version !== WC_MARKER_VERSION ||
    !("workingCopyId" in parsed) ||
    typeof parsed.workingCopyId !== "string"
  ) {
    throw new Error(`Invalid working-copy marker: ${markerPath}`);
  }
  return { marker: parsed as WcMarker, path: markerPath };
}
