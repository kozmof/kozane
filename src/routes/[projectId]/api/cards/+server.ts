import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "../../../../db/api/bundle";
import { addCard } from "../../../../db/api/card";
import { CANVAS_W, CANVAS_H, CONTENT_MAX, clamp } from "$lib/constants";
import { optionalNumber, readJsonObject, requireString } from "../../lib/request";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const bundleId = requireString(body, "bundleId");
  const content = requireString(body, "content");
  const posX = optionalNumber(body, "posX") ?? 0;
  const posY = optionalNumber(body, "posY") ?? 0;

  if (content.length > CONTENT_MAX)
    throw error(400, `content must be a string under ${CONTENT_MAX} characters`);

  const bundle = await getBundle({ db, projectId, bundleId });
  if (!bundle) throw error(400, "Bundle not found in project");

  const id = await addCard({
    db,
    bundleId,
    content,
    posX: clamp(posX, 0, CANVAS_W),
    posY: clamp(posY, 0, CANVAS_H),
  });

  return json({ id });
};
