import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { moveCardsToNamespace } from "$db/api/composite";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request.js";
import { rejectBatch } from "../../../lib/rejection.js";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const targetNamespaceId = requireString(body, "targetNamespaceId");
  const cardIds = requireStringArray(body, "cardIds");
  if (targetNamespaceId === namespaceId)
    throw error(400, "Target namespace must differ from source");
  const result = await moveCardsToNamespace({
    db,
    sourceNamespaceId: namespaceId,
    targetNamespaceId,
    cardIds,
  });
  if (!result.ok) rejectBatch(result.reason);
  return json({ ok: true });
};
