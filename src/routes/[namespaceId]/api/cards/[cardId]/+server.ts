import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getPartition } from "$db/api/partition";
import { getLayer } from "$db/api/layer";
import { updateCard } from "$db/api/card";
import { deleteNamespaceCards } from "$db/api/composite";
import { requireCardInNamespace } from "../../../lib/guards.js";
import { clamp, contentLimitIssue } from "$lib/constants";
import { CARD_WIDTH_RANGE } from "$lib/ui-config";
import { canvasBounds } from "$lib/server/canvas";
import { contentMax } from "$lib/server/content-limit";
import {
  optionalNullableNumber,
  optionalNumber,
  optionalString,
  readJsonObject,
  requireString,
} from "../../../lib/request.js";

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const { db } = locals;
  const { namespaceId, cardId } = params;
  const body = await readJsonObject(request);

  const { partitionId } = await requireCardInNamespace(db, namespaceId, cardId);

  const rawContent = optionalString(body, "content");
  if (rawContent !== undefined && !rawContent.trim()) throw error(400, "content must not be empty");
  const contentIssue =
    rawContent === undefined ? null : contentLimitIssue(rawContent, contentMax());
  if (contentIssue) throw error(400, contentIssue);
  const content = rawContent !== undefined ? rawContent.trim() : undefined;

  let newPartitionId: string | undefined;
  if (body.partitionId !== undefined) {
    const requestedPartitionId = requireString(body, "partitionId");
    const newPartition = await getPartition({ db, namespaceId, partitionId: requestedPartitionId });
    if (!newPartition) throw error(400, "New partition not found in namespace");
    newPartitionId = requestedPartitionId;
  }

  let newLayerId: string | undefined;
  if (body.layerId !== undefined) {
    const requestedLayerId = requireString(body, "layerId");
    const newLayer = await getLayer({ db, namespaceId, layerId: requestedLayerId });
    if (!newLayer) throw error(400, "New layer not found in namespace");
    newLayerId = requestedLayerId;
  }

  const rawPosX = optionalNumber(body, "posX");
  const rawPosY = optionalNumber(body, "posY");
  const { canvasWidth, canvasHeight } = canvasBounds();
  const posX = rawPosX === undefined ? undefined : clamp(rawPosX, 0, canvasWidth);
  const posY = rawPosY === undefined ? undefined : clamp(rawPosY, 0, canvasHeight);
  const zIndex = optionalNumber(body, "zIndex");
  if (zIndex !== undefined && !Number.isInteger(zIndex))
    throw error(400, "zIndex must be an integer");

  // Null clears the pinned width and restores `ui.defaultCardWidth`. Reject out-of-range
  // widths rather than clamping them.
  const rawWidth = optionalNullableNumber(body, "width");
  const [widthMin, widthMax] = CARD_WIDTH_RANGE;
  if (typeof rawWidth === "number" && !Number.isInteger(rawWidth))
    throw error(400, "width must be an integer");
  if (typeof rawWidth === "number" && (rawWidth < widthMin || rawWidth > widthMax))
    throw error(400, `width must be between ${widthMin} and ${widthMax}`);
  const width = rawWidth;

  if (
    content === undefined &&
    newPartitionId === undefined &&
    newLayerId === undefined &&
    posX === undefined &&
    posY === undefined &&
    zIndex === undefined &&
    width === undefined
  )
    throw error(400, "No fields to update");

  await updateCard({
    db,
    cardId,
    partitionId,
    newPartitionId,
    layerId: newLayerId,
    content,
    posX,
    posY,
    zIndex,
    width,
  });

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId, cardId } = params;

  // Use the deletion result to report a missing card without a separate precheck. Return 404
  // because this URL identifies one card, unlike a batch request.
  const result = await deleteNamespaceCards({ db, namespaceId, cardIds: [cardId] });
  if (!result.ok) throw error(404, "Card not found");

  return json({ ok: true });
};
