import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "../../../../../db/api/bundle";
import { reassignCardsToBundle } from "../../../../../db/api/card";
import { readJsonObject, requireString, requireStringArray } from "../../../lib/request";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const bundleId = requireString(body, "bundleId");
  const bundle = await getBundle({ db, projectId, bundleId });
  if (!bundle) throw error(400, "Bundle not found in project");
  const cardIds = requireStringArray(body, "cardIds");
  if (!(await reassignCardsToBundle({ db, projectId, cardIds, bundleId })))
    throw error(400, "Some cards do not belong to this project");
  return json({ ok: true });
};
