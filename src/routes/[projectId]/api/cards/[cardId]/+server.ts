import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getBundle } from "$db/api/bundle";
import { getLayer } from "$db/api/layer";
import { updateCard } from "$db/api/card";
import { deleteProjectCards } from "$db/api/composite";
import { requireCardInProject } from "../../../lib/guards.js";
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
  const { projectId, cardId } = params;
  const body = await readJsonObject(request);

  const { bundleId } = await requireCardInProject(db, projectId, cardId);

  const rawContent = optionalString(body, "content");
  if (rawContent !== undefined && !rawContent.trim()) throw error(400, "content must not be empty");
  const contentIssue =
    rawContent === undefined ? null : contentLimitIssue(rawContent, contentMax());
  if (contentIssue) throw error(400, contentIssue);
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
  const { canvasWidth, canvasHeight } = canvasBounds();
  const posX = rawPosX === undefined ? undefined : clamp(rawPosX, 0, canvasWidth);
  const posY = rawPosY === undefined ? undefined : clamp(rawPosY, 0, canvasHeight);
  const zIndex = optionalNumber(body, "zIndex");
  if (zIndex !== undefined && !Number.isInteger(zIndex))
    throw error(400, "zIndex must be an integer");

  // Null is a value of its own here: it drops the card's own width and puts it back
  // under `ui.defaultCardWidth`. Out-of-range widths are refused rather than clamped,
  // unlike a position — a card dragged past the edge of the board still means to land
  // somewhere, while a width of 4000 is a caller that has the units wrong.
  const rawWidth = optionalNullableNumber(body, "width");
  const [widthMin, widthMax] = CARD_WIDTH_RANGE;
  if (typeof rawWidth === "number" && !Number.isInteger(rawWidth))
    throw error(400, "width must be an integer");
  if (typeof rawWidth === "number" && (rawWidth < widthMin || rawWidth > widthMax))
    throw error(400, `width must be between ${widthMin} and ${widthMax}`);
  const width = rawWidth;

  if (
    content === undefined &&
    newBundleId === undefined &&
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
    bundleId,
    newBundleId,
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
  const { projectId, cardId } = params;

  // One read rather than two. This used to call `requireCardInProject` first, purely to get
  // the 404 that `deleteProjectCards` could not distinguish from any other refusal; the
  // refusal now says which it is, and the only one this route can meet is the card's.
  //
  // 404 rather than the 400 the batch routes answer with, and that is the difference between
  // the two shapes: here the card is the resource the URL names, so its absence is the
  // status. A batch endpoint names no resource but the project, which exists.
  const result = await deleteProjectCards({ db, projectId, cardIds: [cardId] });
  if (!result.ok) throw error(404, "Card not found");

  return json({ ok: true });
};
