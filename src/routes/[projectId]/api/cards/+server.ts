import type { RequestHandler } from "./$types";
import type { CardWithGlue } from "$lib/types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "$db/api/bundle";
import { getDefaultLayer, getLayer } from "$db/api/layer";
import { getScope } from "$db/api/scope";
import { addScopeRel } from "$db/api/scope-rel";
import { withTx } from "$db/tx";
import { addCard, updateProjectCardPositions, type CardPositionUpdate } from "$db/api/card";
import { deleteProjectCards } from "$db/api/composite";
import { contentLimitIssue } from "$lib/constants";
import { clampToCanvas } from "$lib/server/canvas";
import { contentMax } from "$lib/server/content-limit";
import {
  optionalNumber,
  optionalString,
  readJsonObject,
  requireString,
  requireStringArray,
  requireTrimmedString,
  requireUniqueStrings,
  requireWithinBatchLimit,
} from "../../lib/request.js";
import { rejectBatch } from "../../lib/rejection.js";

function requirePositionUpdates(body: Record<string, unknown>): CardPositionUpdate[] {
  const value = body.positions;
  if (!Array.isArray(value) || value.length === 0) throw error(400, "positions is required");
  // The widest statement any endpoint builds: each position contributes to both CASE
  // expressions and to the WHERE, so the cap matters more here than anywhere else.
  requireWithinBatchLimit(value.length, "positions");

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

    return { cardId: row.cardId, ...clampToCanvas(row.posX, row.posY) };
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
  const requestedLayerId = optionalString(body, "layerId");

  const contentIssue = contentLimitIssue(content, contentMax());
  if (contentIssue) throw error(400, contentIssue);

  const bundle = await getBundle({ db, projectId, bundleId });
  if (!bundle) throw error(400, "Bundle not found in project");
  if (scopeId && !(await getScope({ db, scopeId }))) throw error(400, "Scope not found");

  // An unknown layer is rejected rather than silently redirected to the default one:
  // a card that quietly lands on another layer is invisible to the client that asked.
  const layer = requestedLayerId
    ? await getLayer({ db, projectId, layerId: requestedLayerId })
    : await getDefaultLayer({ db, projectId });
  if (!layer)
    throw error(
      400,
      requestedLayerId ? "Layer not found in project" : "Project has no default layer",
    );

  const stored = {
    bundleId,
    layerId: layer.id,
    content,
    ...clampToCanvas(posX, posY),
    zIndex,
  };

  const id = await withTx(db, async (tx) => {
    const cardId = await addCard({ db: tx, ...stored });
    if (scopeId) await addScopeRel({ db: tx, scopeId, cardId });
    return cardId;
  });

  // The whole stored row, not just the id: posX/posY were clamped above, so a client
  // that echoed back what it sent would render the card in the wrong place until the
  // next snapshot poll corrected it. A new card has no width of its own — it is drawn
  // at `ui.defaultCardWidth` until someone resizes it.
  return json({
    id,
    ...stored,
    taskspaceId: null,
    glueId: null,
    width: null,
  } satisfies CardWithGlue);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const positions = requirePositionUpdates(body);

  const result = await updateProjectCardPositions({ db, projectId, positions });
  if (!result.ok) rejectBatch(result.reason);

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { projectId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");
  const result = await deleteProjectCards({ db, projectId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return json({ ok: true });
};
