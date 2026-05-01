import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "../../../../../db/api/bundle";
import { updateCard, deleteCard } from "../../../../../db/api/card";
import { requireCardInProject } from "../../../lib/guards";
import { CANVAS_W, CANVAS_H, CONTENT_MAX, clamp } from "$lib/constants";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId, cardId } = params;
  const body = await request.json();

  await requireCardInProject(db, projectId, cardId);

  if (body.content !== undefined) {
    if (typeof body.content !== "string" || body.content.length > CONTENT_MAX)
      throw error(400, `content must be a string under ${CONTENT_MAX} characters`);
  }

  let newBundleId: string | undefined;
  if (body.bundleId !== undefined) {
    const newBundle = await getBundle({ db, projectId, bundleId: body.bundleId });
    if (!newBundle) throw error(400, "New bundle not found in project");
    newBundleId = body.bundleId;
  }

  let posX: number | undefined;
  let posY: number | undefined;
  if (body.posX !== undefined) {
    if (typeof body.posX !== "number") throw error(400, "posX must be a number");
    posX = clamp(body.posX, 0, CANVAS_W);
  }
  if (body.posY !== undefined) {
    if (typeof body.posY !== "number") throw error(400, "posY must be a number");
    posY = clamp(body.posY, 0, CANVAS_H);
  }

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
