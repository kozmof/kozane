import type { RequestHandler } from "./$types";
import type { CardWithGlue } from "$lib/types";
import { json, error } from "@sveltejs/kit";
import { getPartition } from "$db/api/partition";
import { getDefaultLayer, getLayer } from "$db/api/layer";
import { getScope } from "$db/api/scope";
import { addScopeRel } from "$db/api/scope-rel";
import { withTx } from "$db/tx";
import { addCard, updateNamespaceCardPositions, type CardPositionUpdate } from "$db/api/card";
import { deleteNamespaceCards } from "$db/api/composite";
import { contentLimitIssue } from "$lib/constants";
import { clampToCanvas } from "$lib/server/canvas";
import { contentMax } from "$lib/server/content-limit";
import {
  optionalNumber,
  optionalString,
  readJsonObject,
  requireFiniteNumber,
  requireObjectArray,
  requireString,
  requireStringArray,
  requireTrimmedString,
  requireUniqueStrings,
} from "../../lib/request.js";
import { rejectBatch } from "../../lib/rejection.js";

function requirePositionUpdates(body: Record<string, unknown>): CardPositionUpdate[] {
  // Each position adds parameters to both CASE expressions and WHERE. Enforce the batch cap
  // with `requireObjectArray`.
  const positions = requireObjectArray(
    body,
    "positions",
    (row) => ({
      cardId: requireString(row, "cardId"),
      // Return stored rows because incoming positions are clamped. See POST below.
      ...clampToCanvas(requireFiniteNumber(row, "posX"), requireFiniteNumber(row, "posY")),
    }),
    { message: "positions is required" },
  );

  requireUniqueStrings(
    positions.map((p) => p.cardId),
    "cardId",
  );
  return positions;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const partitionId = requireString(body, "partitionId");
  const content = requireTrimmedString(body, "content");
  const posX = optionalNumber(body, "posX") ?? 0;
  const posY = optionalNumber(body, "posY") ?? 0;
  const zIndex = optionalNumber(body, "zIndex") ?? 0;
  if (!Number.isInteger(zIndex)) throw error(400, "zIndex must be an integer");
  const scopeId = optionalString(body, "scopeId");
  const requestedLayerId = optionalString(body, "layerId");

  const contentIssue = contentLimitIssue(content, contentMax());
  if (contentIssue) throw error(400, contentIssue);

  // The lookups run inside the transaction that writes, so a partition, layer, or scope
  // removed by another writer in between is a 400 here rather than a foreign-key 500.
  const { id, stored } = await withTx(db, async (tx) => {
    const partition = await getPartition({ db: tx, namespaceId, partitionId });
    if (!partition) throw error(400, "Partition not found in namespace");
    if (scopeId && !(await getScope({ db: tx, scopeId }))) throw error(400, "Scope not found");

    // Reject unknown layers so cards cannot silently move to a layer the client did not
    // request.
    const layer = requestedLayerId
      ? await getLayer({ db: tx, namespaceId, layerId: requestedLayerId })
      : await getDefaultLayer({ db: tx, namespaceId });
    if (!layer)
      throw error(
        400,
        requestedLayerId ? "Layer not found in namespace" : "Namespace has no default layer",
      );

    const stored = {
      partitionId,
      layerId: layer.id,
      content,
      ...clampToCanvas(posX, posY),
      zIndex,
    };
    const cardId = await addCard({ db: tx, ...stored });
    if (scopeId) await addScopeRel({ db: tx, scopeId, cardId });
    return { id: cardId, stored };
  });

  // Return stored coordinates after clamping so the client renders the saved position
  // immediately. New cards use the configured default width.
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
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const positions = requirePositionUpdates(body);

  const result = await updateNamespaceCardPositions({ db, namespaceId, positions });
  if (!result.ok) rejectBatch(result.reason);

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId } = params;
  const body = await readJsonObject(request);
  const cardIds = requireStringArray(body, "cardIds");
  const result = await deleteNamespaceCards({ db, namespaceId, cardIds });
  if (!result.ok) rejectBatch(result.reason);
  return json({ ok: true });
};
