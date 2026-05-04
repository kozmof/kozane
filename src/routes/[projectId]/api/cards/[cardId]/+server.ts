import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "../../../../../db/api/bundle";
import { updateCard, deleteCard } from "../../../../../db/api/card";
import { requireCardInProject } from "../../../lib/guards";
import { CANVAS_W, CANVAS_H, CONTENT_MAX, clamp } from "$lib/constants";
import { optionalNumber, readJsonObject } from "../../../lib/request";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, cardId } = params;
  const body = await readJsonObject(request);

  await requireCardInProject(db, projectId, cardId);

  if (body.content !== undefined) {
    if (typeof body.content !== "string" || body.content.length > CONTENT_MAX)
      throw error(400, `content must be a string under ${CONTENT_MAX} characters`);
  }

  let newBundleId: string | undefined;
  if (body.bundleId !== undefined) {
    if (typeof body.bundleId !== "string" || body.bundleId.length === 0)
      throw error(400, "bundleId is required");
    const newBundle = await getBundle({ db, projectId, bundleId: body.bundleId });
    if (!newBundle) throw error(400, "New bundle not found in project");
    newBundleId = body.bundleId;
  }

  const rawPosX = optionalNumber(body, "posX");
  const rawPosY = optionalNumber(body, "posY");
  const posX = rawPosX === undefined ? undefined : clamp(rawPosX, 0, CANVAS_W);
  const posY = rawPosY === undefined ? undefined : clamp(rawPosY, 0, CANVAS_H);

  await updateCard({ db, cardId, content: body.content, posX, posY, bundleId: newBundleId });

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, cardId } = params;

  const { bundleId } = await requireCardInProject(db, projectId, cardId);
  await deleteCard({ db, bundleId, cardId });

  return json({ ok: true });
};
