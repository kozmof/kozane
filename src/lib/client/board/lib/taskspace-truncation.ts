import { TASKSPACE_DIR_ENTRIES_MAX, TASKSPACE_SSG_DEPTH_MAX } from "$lib/constants";
import type { TaskspaceTruncation } from "$lib/types";

/**
 * Describe directory truncation reasons consistently in both the tree panel and frame file
 * strip. Distinguish extra entries from subtrees that were not read.
 */
export function truncationNote(reason: TaskspaceTruncation): string {
  switch (reason) {
    case "entries":
      return `First ${TASKSPACE_DIR_ENTRIES_MAX} entries only`;
    case "depth":
      return `Nested deeper than ${TASKSPACE_SSG_DEPTH_MAX} levels — not included in this export`;
    case "nodes":
      return "Past this export's size limit — not included";
    case "unreadable":
      return "Could not be read";
  }
}
