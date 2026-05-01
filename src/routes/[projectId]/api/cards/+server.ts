import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "../../../../db/api/bundle";
import { addCard } from "../../../../db/api/card";
import { CANVAS_W, CANVAS_H, CONTENT_MAX, clamp } from "$lib/constants";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await request.json();
  const { bundleId, content } = body;
  const posX = typeof body.posX === "number" ? body.posX : 0;
  const posY = typeof body.posY === "number" ? body.posY : 0;

  if (!bundleId || !content) throw error(400, "bundleId and content are required");
  if (typeof content !== "string" || content.length > CONTENT_MAX)
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
