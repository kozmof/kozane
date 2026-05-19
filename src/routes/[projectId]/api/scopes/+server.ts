import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { addScope, addProjectScopeRel } from "../../../../db/api/scope";
import { readJsonObject, requireTrimmedString } from "../../lib/request";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");

  const id = await addScope({ db, name });
  await addProjectScopeRel({ db, projectId, scopeId: id });
  return json({ id });
};
