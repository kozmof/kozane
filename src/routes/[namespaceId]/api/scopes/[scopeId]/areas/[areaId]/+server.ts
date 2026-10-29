import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { moveScopeArea, deleteScopeArea } from "$db/api/scope-area";
import { readJsonObject } from "../../../../../lib/request.js";
import { readAreaRect } from "../../../../../lib/scope-area-request.js";
import { clampRectToCanvas } from "$lib/server/canvas";
import { apiHandler } from "../../../../../lib/api-handler.js";

const AREA_NOT_FOUND = { notFound: "Scope area not found" };

/** Move or resize one frame using a complete rectangle. */
export const PATCH: RequestHandler = apiHandler(async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, scopeId, areaId } = params;
  const rect = readAreaRect(await readJsonObject(request));

  return json(
    await moveScopeArea({ db, namespaceId, scopeId, areaId, ...clampRectToCanvas(rect) }),
  );
}, AREA_NOT_FOUND);

/** Remove one frame while preserving scope memberships and other frames. */
export const DELETE: RequestHandler = apiHandler(async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, scopeId, areaId } = params;

  await deleteScopeArea({ db, namespaceId, scopeId, areaId });
  return json({ ok: true });
}, AREA_NOT_FOUND);
