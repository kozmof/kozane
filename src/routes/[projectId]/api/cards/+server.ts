import type { RequestHandler } from "./$types";
import type { CardWithGlue } from "$lib/types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "../../../../db/api/bundle";
import { getScope } from "../../../../db/api/scope";
import { addScopeRel } from "../../../../db/api/scope-rel";
import { withTx } from "../../../../db/tx";
import {
  addCard,
  updateProjectCardPositions,
  type CardPositionUpdate,
} from "../../../../db/api/card";
import { deleteProjectCards } from "../../../../db/api/composite";
import { CANVAS_W, CANVAS_H, CONTENT_MAX, clamp } from "$lib/constants";
import {
  optionalNumber,
  optionalString,
  readJsonObject,
  requireString,
  requireStringArray,
  requireTrimmedString,
  requireUniqueStrings,
} from "../../lib/request";

function requirePositionUpdates(body: Record<string, unknown>): CardPositionUpdate[] {
  const value = body.positions;
  if (!Array.isArray(value) || value.length === 0) throw error(400, "positions is required");

  const positions = value.map((item) => {
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

  requireUniqueStrings(
    positions.map((p) => p.cardId),
    "cardId",
  );
  return positions;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const bundleId = requireString(body, "bundleId");
  const content = requireTrimmedString(body, "content");
  const posX = optionalNumber(body, "posX") ?? 0;
  const posY = optionalNumber(body, "posY") ?? 0;
  const zIndex = optionalNumber(body, "zIndex") ?? 0;
  if (!Number.isInteger(zIndex)) throw error(400, "zIndex must be an integer");
  const scopeId = optionalString(body, "scopeId");

  if (content.length > CONTENT_MAX)
    throw error(400, `content must be a string under ${CONTENT_MAX} characters`);

  const bundle = await getBundle({ db, projectId, bundleId });
  if (!bundle) throw error(400, "Bundle not found in project");
  if (scopeId && !(await getScope({ db, scopeId }))) throw error(400, "Scope not found");

  const stored = {
    bundleId,
    content,
    posX: clamp(posX, 0, CANVAS_W),
    posY: clamp(posY, 0, CANVAS_H),
    zIndex,
  };

  const id = await withTx(db, async (tx) => {
    const cardId = await addCard({ db: tx, ...stored });
    if (scopeId) await addScopeRel({ db: tx, scopeId, cardId });
    return cardId;
  });

  // The whole stored row, not just the id: posX/posY were clamped above, so a client
  // that echoed back what it sent would render the card in the wrong place until the
  // next snapshot poll corrected it.
  return json({ id, ...stored, taskspaceId: null, glueId: null } satisfies CardWithGlue);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const positions = requirePositionUpdates(body);

  if (!(await updateProjectCardPositions({ db, projectId, positions })))
    throw error(400, "Some cards do not belong to this project");

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");
  if (!(await deleteProjectCards({ db, projectId, cardIds })))
    throw error(400, "Some cards do not belong to this project");
  return json({ ok: true });
};
