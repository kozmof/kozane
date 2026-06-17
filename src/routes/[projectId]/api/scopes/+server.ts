import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { addScope } from "../../../../db/api/scope";
import { readJsonObject, requireTrimmedString } from "../../lib/request";

export const POST: RequestHandler = async ({ locals, request }) => {
  const { db } = locals;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");

  const id = await addScope({ db, name });
  return json({ id });
};
