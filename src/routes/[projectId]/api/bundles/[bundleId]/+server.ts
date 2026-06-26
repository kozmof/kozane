import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { updateBundleName } from "../../../../../db/api/bundle";
import { deleteBundleWithReassign } from "../../../../../db/api/composite";
import {
  NotFoundError,
  DefaultBundleError,
  isUniqueConstraintError,
} from "../../../../../db/api/utils";
import { readJsonObject, requireTrimmedString } from "../../../lib/request";
import { NAME_MAX } from "$lib/constants";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, bundleId } = params;
  const body = await readJsonObject(request);
  const name = requireTrimmedString(body, "name");

  if (name.length > NAME_MAX) throw error(400, `name must be ${NAME_MAX} characters or fewer`);

  try {
    await updateBundleName({ db, projectId, bundleId, name });
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    if (isUniqueConstraintError(e)) throw error(400, `A bundle named "${name}" already exists`);
    throw e;
  }
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, bundleId } = params;

  try {
    const { defaultBundleId } = await deleteBundleWithReassign({ db, projectId, bundleId });
    return json({ ok: true, defaultBundleId });
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, e.message);
    if (e instanceof DefaultBundleError) throw error(400, e.message);
    throw e;
  }
};
