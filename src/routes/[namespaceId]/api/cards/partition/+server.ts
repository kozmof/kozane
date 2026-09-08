import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { reassignCardsToPartition } from "$db/api/card";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request.js";
import { rejectBatch } from "../../../lib/rejection.js";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const partitionId = requireString(body, "partitionId");
  const cardIds = requireStringArray(body, "cardIds");
  // No `getPartition` first: the transaction checks the partition before it checks the cards, so
  // the answer is the same one this used to pre-compute — and it is decided where the write
  // happens rather than a query earlier.
  const result = await reassignCardsToPartition({ db, namespaceId, cardIds, partitionId });
  if (!result.ok) rejectBatch(result.reason);
  return json({ ok: true });
};
