import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { addScopeArea } from "$db/api/scope-area";
import { readJsonObject } from "../../../../lib/request.js";
import { readAreaRect } from "../../../../lib/scope-area-request.js";
import { clampRectToCanvas } from "$lib/server/canvas";
import { apiHandler } from "../../../../lib/api-handler.js";

/**
 * Add a frame for this scope on this board without replacing existing frames. Move or remove
 * individual frames through `areas/[areaId]`.
 */
export const POST: RequestHandler = apiHandler(
  async ({ locals, params, request }) => {
    const { db } = locals;
    const { namespaceId, scopeId } = params;
    const rect = readAreaRect(await readJsonObject(request));

    // The whole stored row, so a client that drew the frame where the pointer let go cannot
    // keep it at an unclamped rectangle until the next snapshot poll corrects it.
    return json(await addScopeArea({ db, namespaceId, scopeId, ...clampRectToCanvas(rect) }));
  },
  { foreignKey: "Scope not found" },
);
