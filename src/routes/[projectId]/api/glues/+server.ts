import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { glueProjectCards, unglueProjectCards } from "$db/api/glue";
import { readJsonObject, requireStringArray } from "../../lib/request.js";
import { rejectBatch } from "../../lib/rejection.js";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds", 2);

  const result = await glueProjectCards({ db, projectId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return json({ glueId: result.glueId });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");

  const result = await unglueProjectCards({ db, projectId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return json({ ok: true, clearedCardIds: result.clearedCardIds });
};
