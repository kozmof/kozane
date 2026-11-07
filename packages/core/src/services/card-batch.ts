import { and, eq } from "drizzle-orm";
import type { Tx } from "../database.js";
import { partitionTable, cardTable } from "../schema.js";
import { addCardsInTx, onCanvas } from "../../../../src/db/api/card.js";
import { addScopeRels } from "../../../../src/db/api/scope-rel.js";
import { getPartition } from "../../../../src/db/api/partition.js";
import { getLayer } from "../../../../src/db/api/layer.js";
import { getScope } from "../../../../src/db/api/scope.js";
import { addSquashInventoryInTx } from "../../../../src/db/api/inventory.js";
import { squashCardPositions, squashInventorySlots } from "../squash.js";
import { clamp, contentLimitIssue } from "../constants/index.js";
import type { ServiceContext } from "./context.js";
import { ValidationError } from "./errors.js";
import { prepareInput } from "./prepare-input.js";
import { optionalNumber, requireString, optionalId } from "./validation.js";

/** Parsed text segments are supplied by adapters; core validates and lays out stored cards. */
export async function createInTx(
  tx: Tx,
  context: ServiceContext,
  namespaceId: string,
  input: Record<string, unknown>,
) {
  const body = prepareInput(input);
  const partitionId = requireString(body, "partitionId");
  const layerId = requireString(body, "layerId");
  const scopeId = optionalId(body, "scopeId");
  if (!Array.isArray(body.contents) || body.contents.length === 0)
    throw new ValidationError("Content must contain at least one non-empty card.");
  const contents = body.contents.map((value, index) => {
    if (typeof value !== "string" || !value.trim())
      throw new ValidationError("Content must contain at least one non-empty card.");
    const content = value.trim();
    const issue = contentLimitIssue(content, context.contentMax);
    if (issue)
      throw new ValidationError(
        `Card ${index + 1} of ${(body.contents as unknown[]).length}: ${issue}`,
      );
    return content;
  });
  const slots = squashInventorySlots(contents);
  if (!slots)
    throw new ValidationError(
      `${contents.length} cards do not fit in one inventory. Split the text more coarsely.`,
    );
  if (!(await getPartition({ db: tx, namespaceId, partitionId })))
    throw new ValidationError("Partition not found in namespace");
  if (!(await getLayer({ db: tx, namespaceId, layerId })))
    throw new ValidationError("Layer not found in namespace");
  if (scopeId && !(await getScope({ db: tx, scopeId })))
    throw new ValidationError("Scope not found");
  const position = (posX: number, posY: number) => ({
    posX: Math.round(clamp(posX, 0, context.canvasWidth)),
    posY: Math.round(clamp(posY, 0, context.canvasHeight)),
  });
  const origin = position(optionalNumber(body, "posX") ?? 0, optionalNumber(body, "posY") ?? 0);
  const occupied = await tx
    .select({ posX: cardTable.posX, posY: cardTable.posY })
    .from(cardTable)
    .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
    .where(and(eq(partitionTable.namespaceId, namespaceId), onCanvas));
  const positions = squashCardPositions(occupied, contents.length, {
    origin,
    canvasWidth: context.canvasWidth,
  });
  const inventory = await addSquashInventoryInTx({ db: tx, namespaceId, ...origin });
  const ids = await addCardsInTx({
    db: tx,
    partitionId,
    layerId,
    cards: contents.map((content, index) => ({
      content,
      ...position(positions[index].posX, positions[index].posY),
      inventory: { id: inventory.id, slot: slots[index] },
    })),
  });
  if (scopeId) await addScopeRels({ db: tx, scopeId, cardIds: ids });
  return { inventory, ids };
}
