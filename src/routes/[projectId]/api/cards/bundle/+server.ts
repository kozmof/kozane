import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { reassignCardsToBundle } from "$db/api/card";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request.js";
import { rejectBatch } from "../../../lib/rejection.js";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const bundleId = requireString(body, "bundleId");
  const cardIds = requireStringArray(body, "cardIds");
  // No `getBundle` first: the transaction checks the bundle before it checks the cards, so
  // the answer is the same one this used to pre-compute — and it is decided where the write
  // happens rather than a query earlier.
  const result = await reassignCardsToBundle({ db, projectId, cardIds, bundleId });
  if (!result.ok) rejectBatch(result.reason);
  return json({ ok: true });
};
