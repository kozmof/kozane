import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { moveScopeArea, deleteScopeArea } from "$db/api/scope-area";
import { NotFoundError } from "$db/api/utils";
import { readJsonObject } from "../../../../../lib/request.js";
import { readAreaRect } from "../../../../../lib/scope-area-request.js";
import { clampRectToCanvas } from "$lib/server/canvas";

/** Move or resize one frame using a complete rectangle. */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, scopeId, areaId } = params;
  const rect = readAreaRect(await readJsonObject(request));

  try {
    return json(
      await moveScopeArea({ db, namespaceId, scopeId, areaId, ...clampRectToCanvas(rect) }),
    );
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, "Scope area not found");
    throw e;
  }
};

/** Remove one frame while preserving scope memberships and other frames. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, scopeId, areaId } = params;

  try {
    await deleteScopeArea({ db, namespaceId, scopeId, areaId });
  } catch (e) {
    if (e instanceof NotFoundError) throw error(404, "Scope area not found");
    throw e;
  }

  return json({ ok: true });
};
