import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "../../../../db/api/bundle";
import { addCard, updateCardPositions, type CardPositionUpdate } from "../../../../db/api/card";
import { CANVAS_W, CANVAS_H, CONTENT_MAX, clamp } from "$lib/constants";
import { optionalNumber, readJsonObject, requireString } from "../../lib/request";
import { allCardsBelongToProject } from "../../lib/guards";

function requirePositionUpdates(body: Record<string, unknown>): CardPositionUpdate[] {
  const value = body.positions;
  if (!Array.isArray(value) || value.length === 0) throw error(400, "positions is required");

  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw error(400, "positions must contain objects");

    const row = item as Record<string, unknown>;
    if (typeof row.cardId !== "string" || row.cardId.length === 0)
      throw error(400, "cardId is required");
    if (typeof row.posX !== "number" || !Number.isFinite(row.posX))
      throw error(400, "posX must be a number");
    if (typeof row.posY !== "number" || !Number.isFinite(row.posY))
      throw error(400, "posY must be a number");

    return {
      cardId: row.cardId,
      posX: clamp(row.posX, 0, CANVAS_W),
      posY: clamp(row.posY, 0, CANVAS_H),
    };
  });
}

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

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const positions = requirePositionUpdates(body);
  const cardIds = positions.map((position) => position.cardId);

  if (!(await allCardsBelongToProject(db, projectId, cardIds)))
    throw error(400, "Some cards do not belong to this project");

  await updateCardPositions({ db, positions });

  return json({ ok: true });
};
