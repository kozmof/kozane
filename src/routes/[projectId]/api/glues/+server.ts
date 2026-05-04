import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { glueCards, unglueCards } from "../../../../db/api/glue";
import { allCardsBelongToProject } from "../../lib/guards";
import { readJsonObject, requireStringArray } from "../../lib/request";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds", 2);

  if (!(await allCardsBelongToProject(db, projectId, cardIds)))
    throw error(400, "Some cards do not belong to this project");

  const glueId = await glueCards({ db, cardIds });
  return json({ glueId });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");

  if (!(await allCardsBelongToProject(db, projectId, cardIds)))
    throw error(400, "Some cards do not belong to this project");

  await unglueCards({ db, cardIds });
  return json({ ok: true });
};
