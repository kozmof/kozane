import { TASKSPACE_DIR_ENTRIES_MAX, TASKSPACE_SSG_DEPTH_MAX } from "$lib/constants";
import type { TaskspaceTruncation } from "$lib/types";

/**
 * Why a directory is not all there, in words.
 *
 * Each limit in its own words: told only that a directory was "truncated", a reader has no
 * way to tell a folder with more files in it from one this export never walked into.
 *
 * Its own module because two surfaces now say this — the panel's tree, where it started, and
 * the icon strip under a scope frame. Four cases written out twice is a convention rather
 * than a relationship: the wording would drift on the first edit to either, and nothing would
 * catch it. The same argument `WalkTruncation` in `lib/types.ts` makes for naming the reasons
 * once instead of listing them per walk.
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
