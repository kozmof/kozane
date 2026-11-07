import { error } from "@sveltejs/kit";
import type { BatchRejection } from "$db/api/utils";

/**
 * Map transaction refusal reasons to consistent batch error messages and 400 responses. Cover
 * every {@link BatchRejection} so new reasons require a message. Single-resource routes
 * handle missing resources with 404 separately.
 */
const BATCH_REJECTION_MESSAGE: Record<BatchRejection, string> = {
  "foreign-cards": "Some cards do not belong to this namespace",
  "foreign-partition": "Partition not found in namespace",
  "foreign-layer": "Layer not found in namespace",
  "foreign-scope": "Scope not found",
  "foreign-inventory": "Inventory not found in namespace",
  "missing-namespace": "Target namespace not found",
  "inventory-full": "Inventory has no free slot there",
  "stored-cards": "Stored cards cannot be glued",
  "unstored-cards": "Card is not stored in an inventory",
};

/** Ends the request with the wording for `reason`. */
export function rejectBatch(reason: BatchRejection): never {
  throw error(400, BATCH_REJECTION_MESSAGE[reason]);
}
