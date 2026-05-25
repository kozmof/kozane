import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { addScope, addProjectScopeRel } from "../../../../db/api/scope";
import { withTx } from "../../../../db/tx";
import { readJsonObject, requireTrimmedString } from "../../lib/request";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");

  const id = await withTx(db, async (tx) => {
    const scopeId = await addScope({ db: tx, name });
    await addProjectScopeRel({ db: tx, projectId, scopeId });
    return scopeId;
  });
  return json({ id });
};
