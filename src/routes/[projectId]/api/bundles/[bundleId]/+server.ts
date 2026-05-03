import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle, getDefaultBundle, deleteBundle } from "../../../../../db/api/bundle";
import { reassignBundleCards } from "../../../../../db/api/card";

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, bundleId } = params;

  const bundle = await getBundle({ db, projectId, bundleId });
  if (!bundle) throw error(404, "Bundle not found");
  if (bundle.isDefault) throw error(400, "Cannot delete the default bundle");

  const defaultBundle = await getDefaultBundle({ db, projectId });
  if (!defaultBundle) throw error(500, "No default bundle found for this project");

  await reassignBundleCards({ db, fromBundleId: bundleId, toBundleId: defaultBundle.id });
  await deleteBundle({ db, projectId, bundleId });

  return json({ ok: true, defaultBundleId: defaultBundle.id });
};
