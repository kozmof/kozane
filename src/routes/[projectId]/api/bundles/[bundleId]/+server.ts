import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle, deleteBundle } from "../../../../../db/api/bundle";

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, bundleId } = params;

  const bundle = await getBundle({ db, projectId, bundleId });
  if (!bundle) throw error(404, "Bundle not found");

  await deleteBundle({ db, projectId, bundleId });

  return json({ ok: true });
};
