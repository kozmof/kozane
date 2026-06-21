import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addBundle, getAllBundles } from "../../../../db/api/bundle";
import { readJsonObject, requireTrimmedString } from "../../lib/request";
import { NAME_MAX } from "$lib/constants";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");

  if (name.length > NAME_MAX) throw error(400, `name must be ${NAME_MAX} characters or fewer`);

  const existing = await getAllBundles({ db, projectId });
  if (existing.some((b) => b.name === name))
    throw error(400, `A bundle named "${name}" already exists`);

  const id = await addBundle({ db, projectId, name });
  return json({ id });
};
