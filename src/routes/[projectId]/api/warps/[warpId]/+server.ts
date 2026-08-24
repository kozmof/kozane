import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteWarp } from "$db/api/warp";
import { NotFoundError } from "$db/api/utils";

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, warpId } = params;

  try {
    await deleteWarp({ db, projectId, warpId });
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    throw e;
  }
  return json({ ok: true });
};
