/** Labels and commands explaining why a tag listing was cut short. */
import type { TagScanTruncation } from "../types.js";

/** Shared reader-facing labels for scan truncation reasons used by the CLI and tag page. */
const TRUNCATION_LABELS: Record<TagScanTruncation, string> = {
  entries: "a directory held more entries than one scan lists",
  depth: "some directories sit deeper than the scan goes",
  nodes: "it holds more files and directories than one scan visits",
  budget: "some files were larger than the scan had budget left for",
  hits: "it holds more tags than one scan gathers, so the counts above are a floor",
  "too-large": "some files are larger than one file may be to be read at all",
  unreadable: "some files could not be read",
};

/**
 * Join truncation labels with fallback wording for unknown serialized values. Declare the
 * label table exhaustively but allow missing lookups at this boundary so older clients handle
 * newer reasons.
 */
export function truncationReasons(reasons: TagScanTruncation[]): string {
  const labels: Partial<Record<TagScanTruncation, string>> = TRUNCATION_LABELS;
  return reasons.map((reason) => labels[reason] ?? UNKNOWN_TRUNCATION_LABEL).join("; ");
}

/** Fallback label for unknown reasons. See {@link truncationReasons}. */
const UNKNOWN_TRUNCATION_LABEL = "some of it was not read, for a reason this page cannot name";

/** Shared message for card-hit truncation, separate from taskspace scan limits. */
export const CARDS_TRUNCATED_LABEL =
  "more cards carry tags than one gather reads, so the counts above are a floor";

/**
 * Describe an unavailable taskspace by name. Keep this separate from partial-scan labels
 * because its root was not read at all.
 */
export const missingTaskspaceLabel = (name: string): string =>
  `${name} could not be read — its directory has been deleted, moved, or made unreadable since the record naming it was written, so no tag written in it is listed here`;

/**
 * Shared taskspace repair command and surrounding text. Keep them separate so the terminal
 * and page can format the command differently.
 */
export const TASKSPACE_CLEANUP_COMMAND = "kozane taskspace scan --apply --cleanup";

/** Text after {@link TASKSPACE_CLEANUP_COMMAND}, covering all unavailable taskspaces. */
export const cleanupCommandTail = (count: number): string =>
  count === 1 ? "to drop the record." : "to drop the records.";

/**
 * Format a sample of affected paths, or return an empty phrase when none are supplied. Accept
 * absent path lists from older serialized results.
 */
export function truncationPaths(paths: string[] | undefined): string {
  if (!paths || paths.length === 0) return "";
  return ` (for example ${paths.join(", ")})`;
}
