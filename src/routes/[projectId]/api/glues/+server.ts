import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { glueProjectCards, unglueProjectCards } from "../../../../db/api/glue";
import { readJsonObject, requireStringArray } from "../../lib/request";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds", 2);

  const glueId = await glueProjectCards({ db, projectId, cardIds });
  if (glueId === null) throw error(400, "Some cards do not belong to this project");
  return json({ glueId });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");

  const clearedCardIds = await unglueProjectCards({ db, projectId, cardIds });
  if (clearedCardIds === null) throw error(400, "Some cards do not belong to this project");
  return json({ ok: true, clearedCardIds });
};
