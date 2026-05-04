import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { glueCards, unglueCards } from "../../../../db/api/glue";
import { allCardsBelongToProject } from "../../lib/guards";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const { cardIds } = await request.json();

  if (!Array.isArray(cardIds) || cardIds.length < 2)
    throw error(400, "cardIds must be an array of at least 2");

  if (!(await allCardsBelongToProject(db, projectId, cardIds)))
    throw error(400, "Some cards do not belong to this project");

  const glueId = await glueCards({ db, cardIds });
  return json({ glueId });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const { cardIds } = await request.json();

  if (!Array.isArray(cardIds) || cardIds.length === 0) throw error(400, "cardIds is required");

  if (!(await allCardsBelongToProject(db, projectId, cardIds)))
    throw error(400, "Some cards do not belong to this project");

  await unglueCards({ db, cardIds });
  return json({ ok: true });
};
