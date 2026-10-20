import type { RequestHandler } from "./$types";
import { json, error } from "@sveltejs/kit";
import { getPartition } from "$db/api/partition";
import { getLayer } from "$db/api/layer";
import { reassignCardsToLayerInTx, updateCard, type CardStacking } from "$db/api/card";
import { withTx } from "$db/tx";
import { deleteNamespaceCards } from "$db/api/composite";
import { refitStoredCardInTx, type Refit } from "$db/api/inventory";
import { requireCardInNamespace } from "../../../lib/guards.js";
import { checkCardContent, clamp } from "$lib/constants";
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

  // Validate the body before opening the transaction. None of these checks reads the
  // database, so running them inside it would only hold the write lock longer against CLI
  // writers.
  const rawContent = optionalString(body, "content");
  let content: string | undefined;
  if (rawContent !== undefined) {
    const checked = checkCardContent(rawContent, contentMax());
    if (!checked.ok) throw error(400, checked.issue);
    content = checked.content;
  }

  const requestedPartitionId =
    body.partitionId === undefined ? undefined : requireString(body, "partitionId");
  const requestedLayerId = body.layerId === undefined ? undefined : requireString(body, "layerId");

  // Rounded as `clampToBounds` does, because the position columns are integers.
  const rawPosX = optionalNumber(body, "posX");
  const rawPosY = optionalNumber(body, "posY");
  const { canvasWidth, canvasHeight } = canvasBounds();
  const posX = rawPosX === undefined ? undefined : Math.round(clamp(rawPosX, 0, canvasWidth));
  const posY = rawPosY === undefined ? undefined : Math.round(clamp(rawPosY, 0, canvasHeight));
  const zIndex = optionalNumber(body, "zIndex");
  if (zIndex !== undefined && !Number.isSafeInteger(zIndex))
    throw error(400, "zIndex must be an integer");

  // Null clears the pinned width and restores `ui.defaultCardWidth`. Reject out-of-range
  // widths rather than clamping them.
  const width = optionalNullableNumber(body, "width");
  const [widthMin, widthMax] = CARD_WIDTH_RANGE;
  if (typeof width === "number" && !Number.isInteger(width))
    throw error(400, "width must be an integer");
  if (typeof width === "number" && (width < widthMin || width > widthMax))
    throw error(400, `width must be between ${widthMin} and ${widthMax}`);

  if (
    content === undefined &&
    requestedPartitionId === undefined &&
    requestedLayerId === undefined &&
    posX === undefined &&
    posY === undefined &&
    zIndex === undefined &&
    width === undefined
  )
    throw error(400, "No fields to update");

  // Every lookup runs inside the transaction that writes, as in the collection POST, so a
  // card, partition, or layer removed by another writer in between is a 404 or 400 here
  // rather than a foreign-key or not-found 500.
  const { stacking, refit } = await withTx(
    db,
    async (tx): Promise<{ stacking: CardStacking[]; refit: Refit | null }> => {
      const { partitionId } = await requireCardInNamespace(tx, namespaceId, cardId);

      if (
        requestedPartitionId !== undefined &&
        !(await getPartition({ db: tx, namespaceId, partitionId: requestedPartitionId }))
      )
        throw error(400, "New partition not found in namespace");
      const newPartitionId = requestedPartitionId;

      if (
        requestedLayerId !== undefined &&
        !(await getLayer({ db: tx, namespaceId, layerId: requestedLayerId }))
      )
        throw error(400, "New layer not found in namespace");
      const newLayerId = requestedLayerId;

      // A layer change restacks the card above the destination's cards, as the batch layer
      // route does, so it does not keep a zIndex from the layer it left. An explicit zIndex in
      // the same body is applied afterwards and wins.
      let stacking: CardStacking[] = [];
      if (newLayerId !== undefined) {
        const moved = await reassignCardsToLayerInTx({
          db: tx,
          namespaceId,
          cardIds: [cardId],
          layerId: newLayerId,
        });
        // Both were checked above inside this transaction, so a refusal here is a bug.
        if (!moved.ok) throw new Error(`reassignCardsToLayerInTx refused: ${moved.reason}`);
        stacking = moved.stacking;
      }

      const rest = { newPartitionId, content, posX, posY, zIndex, width };
      if (Object.values(rest).some((value) => value !== undefined))
        await updateCard({ db: tx, cardId, partitionId, ...rest });
      // Longer text can overlap neighbouring cards in an inventory. Move the edited card to
      // the first free slot and return every changed position, including repaired neighbours,
      // so the board can update immediately.
      const refit = content === undefined ? null : await refitStoredCardInTx({ db: tx, cardId });
      return { stacking, refit };
    },
  );

  return json({
    ok: true,
    stacking,
    ...(refit?.moved && { inventory: { id: refit.moved.inventoryId, slot: refit.moved.slot } }),
    ...(refit && refit.placements.length > 0 && { placements: refit.placements }),
  });
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
