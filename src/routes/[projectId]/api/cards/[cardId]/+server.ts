import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "../../../../../db/api/bundle";
import { getLayer } from "../../../../../db/api/layer";
import { updateCard } from "../../../../../db/api/card";
import { deleteProjectCards } from "../../../../../db/api/composite";
import { requireCardInProject } from "../../../lib/guards";
import { CANVAS_W, CANVAS_H, CONTENT_MAX, clamp } from "$lib/constants";
import {
  optionalNumber,
  optionalString,
  readJsonObject,
  requireString,
} from "../../../lib/request";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, cardId } = params;
  const body = await readJsonObject(request);

  const { bundleId } = await requireCardInProject(db, projectId, cardId);

  const rawContent = optionalString(body, "content");
  if (rawContent !== undefined && !rawContent.trim()) throw error(400, "content must not be empty");
  if (rawContent !== undefined && rawContent.length > CONTENT_MAX)
    throw error(400, `content must be a string under ${CONTENT_MAX} characters`);
  const content = rawContent !== undefined ? rawContent.trim() : undefined;

  let newBundleId: string | undefined;
  if (body.bundleId !== undefined) {
    const requestedBundleId = requireString(body, "bundleId");
    const newBundle = await getBundle({ db, projectId, bundleId: requestedBundleId });
    if (!newBundle) throw error(400, "New bundle not found in project");
    newBundleId = requestedBundleId;
  }

  let newLayerId: string | undefined;
  if (body.layerId !== undefined) {
    const requestedLayerId = requireString(body, "layerId");
    const newLayer = await getLayer({ db, projectId, layerId: requestedLayerId });
    if (!newLayer) throw error(400, "New layer not found in project");
    newLayerId = requestedLayerId;
  }

  const rawPosX = optionalNumber(body, "posX");
  const rawPosY = optionalNumber(body, "posY");
  const posX = rawPosX === undefined ? undefined : clamp(rawPosX, 0, CANVAS_W);
  const posY = rawPosY === undefined ? undefined : clamp(rawPosY, 0, CANVAS_H);
  const zIndex = optionalNumber(body, "zIndex");
  if (zIndex !== undefined && !Number.isInteger(zIndex))
    throw error(400, "zIndex must be an integer");

  if (
    content === undefined &&
    newBundleId === undefined &&
    newLayerId === undefined &&
    posX === undefined &&
    posY === undefined &&
    zIndex === undefined
  )
    throw error(400, "No fields to update");

  await updateCard({
    db,
    cardId,
    bundleId,
    newBundleId,
    layerId: newLayerId,
    content,
    posX,
    posY,
    zIndex,
  });

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, cardId } = params;

  // Kept for the 404: deleteProjectCards reports a missing card as a plain `false`.
  await requireCardInProject(db, projectId, cardId);
  await deleteProjectCards({ db, projectId, cardIds: [cardId] });

  return json({ ok: true });
};
