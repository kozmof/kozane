import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { glueNamespaceCards, unglueNamespaceCards } from "$db/api/glue";
import { readJsonObject, requireStringArray } from "../../lib/request.js";
import { rejectBatch } from "../../lib/rejection.js";
import { apiHandler } from "../../lib/api-handler.js";

export const POST: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds", 2);

  const result = await glueNamespaceCards({ db, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return json({ glueId: result.glueId, clearedCardIds: result.clearedCardIds });
});

export const DELETE: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");

  const result = await unglueNamespaceCards({ db, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return json({ ok: true, clearedCardIds: result.clearedCardIds });
});
