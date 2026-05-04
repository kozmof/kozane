import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { addBundle } from "../../../../db/api/bundle";
import { readJsonObject, requireTrimmedString } from "../../lib/request";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");

  const id = await addBundle({ db, projectId, name });
  return json({ id });
};
