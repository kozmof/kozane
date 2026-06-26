import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "../../../../../db/api/bundle";
import { updateCard, deleteCard } from "../../../../../db/api/card";
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

  const rawPosX = optionalNumber(body, "posX");
  const rawPosY = optionalNumber(body, "posY");
  const posX = rawPosX === undefined ? undefined : clamp(rawPosX, 0, CANVAS_W);
  const posY = rawPosY === undefined ? undefined : clamp(rawPosY, 0, CANVAS_H);

  if (
    content === undefined &&
    newBundleId === undefined &&
    posX === undefined &&
    posY === undefined
  )
    throw error(400, "No fields to update");

  await updateCard({ db, cardId, bundleId, newBundleId, content, posX, posY });

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { projectId, cardId } = params;

  const { bundleId } = await requireCardInProject(db, projectId, cardId);
  await deleteCard({ db, bundleId, cardId });

  return json({ ok: true });
};
