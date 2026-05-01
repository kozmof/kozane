import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { addScope } from "../../../../db/api/scope";

export const POST: RequestHandler = async ({ locals, request }) => {
  const { db } = locals;
  const body = await request.json();
  const { name } = body;

  if (!name?.trim()) throw error(400, "name is required");

  const id = await addScope({ db, name: name.trim() });
  return json({ id });
};
