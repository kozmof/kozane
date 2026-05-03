import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addBundle } from "../../../../db/api/bundle";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await request.json();
  const { name } = body;

  if (!name?.trim()) throw error(400, "name is required");

  const id = await addBundle({ db, projectId, name: name.trim() });
  return json({ id });
};
