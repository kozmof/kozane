import { error } from "@sveltejs/kit";
import type { BatchRejection } from "$db/api/utils";

/**
 * The wording for each way a batch operation is refused, in one place.
 *
 * The string `"Some cards do not belong to this project"` was written out in eight
 * handlers, because a `boolean` refusal left nothing else to say. Two consequences, and
 * both were real:
 *
 * - It was said where it was not true. `DELETE /[projectId]/api/scopes/[scopeId]/members`
 *   answered it for a request naming a scope that does not exist, whose cards were fine.
 * - Where it *was* true, keeping it true cost a query. `cards/bundle` and `cards/layer`
 *   each looked their destination up before calling, so that a missing bundle or layer
 *   could be named separately — a read the transaction then did again, and did properly,
 *   since the pre-check's answer was already stale by the time the write used it.
 *
 * The `db/api` functions now return the reason they decided on, inside the transaction that
 * decided it, and this turns it into a response. Adding a reason to {@link BatchRejection}
 * is a missing key here rather than a message that quietly stays wrong.
 *
 * All 400: every one of these is a request naming something the project does not have, and
 * that is the same answer whether the row is elsewhere or nowhere. The single-card routes
 * keep their own 404 — there the named thing *is* the resource, so its absence is the
 * status. See the note on {@link BatchRejection}.
 */
const BATCH_REJECTION_MESSAGE: Record<BatchRejection, string> = {
  "foreign-cards": "Some cards do not belong to this project",
  "foreign-bundle": "Bundle not found in project",
  "foreign-layer": "Layer not found in project",
  "foreign-scope": "Scope not found",
};

/** Ends the request with the wording for `reason`. */
export function rejectBatch(reason: BatchRejection): never {
  throw error(400, BATCH_REJECTION_MESSAGE[reason]);
}
