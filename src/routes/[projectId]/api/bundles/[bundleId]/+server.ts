import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { deleteBundleWithReassign } from "../../../../../db/api/composite";
import { NotFoundError } from "../../../../../db/api/utils";

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, bundleId } = params;

  try {
    const { defaultBundleId } = await deleteBundleWithReassign({ db, projectId, bundleId });
    return json({ ok: true, defaultBundleId });
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    if (e instanceof Error && e.message === "Cannot delete the default bundle")
      throw error(400, e.message);
    throw e;
  }
};
