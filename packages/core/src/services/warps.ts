export type { WarpCreateInput, WarpUpdateInput } from "./inputs.js";
import { withTx } from "../database.js";
import { prepareInput } from "./prepare-input.js";
import type { DB, Tx } from "../database.js";
import type { ServiceContext } from "./context.js";
import { ValidationError } from "./errors.js";
import { clamp } from "../../../../src/lib/constants.js";
function clampPosition(posX: number, posY: number, context: ServiceContext) {
  return {
    posX: Math.round(clamp(posX, 0, context.canvasWidth)),
    posY: Math.round(clamp(posY, 0, context.canvasHeight)),
  };
}
import { addWarp, moveWarp, deleteWarp } from "../../../../src/db/api/warp.js";
import { optionalNumber } from "./validation.js";

export async function createInTx(
  db: Tx,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  if (posX === undefined || posY === undefined)
    throw new ValidationError("posX and posY are required");
  // Round coordinates to integers and clamp them to the configured canvas so warps remain
  // reachable.
  const clamped = clampPosition(posX, posY, context);
  const stored = { posX: Math.round(clamped.posX), posY: Math.round(clamped.posY) };
  // The whole stored row, so a client that echoed back what it sent cannot draw the
  // marker off the clamped position until the next snapshot poll corrects it.
  return await addWarp({ db, namespaceId, ...stored });
}

export async function updateInTx(
  db: Tx,
  context: ServiceContext,
  namespaceId: string,
  warpId: string,
  body: Record<string, unknown>,
) {
  body = prepareInput(body);
  const posX = optionalNumber(body, "posX");
  const posY = optionalNumber(body, "posY");
  if (posX === undefined || posY === undefined)
    throw new ValidationError("posX and posY are required");
  // Round and clamp moved warps using the same rules as newly created warps.
  const clamped = clampPosition(posX, posY, context);
  const stored = { posX: Math.round(clamped.posX), posY: Math.round(clamped.posY) };
  return await moveWarp({ db, namespaceId, warpId, ...stored });
}

export async function removeInTx(
  db: Tx,
  context: ServiceContext,
  namespaceId: string,
  warpId: string,
) {
  await deleteWarp({ db, namespaceId, warpId });
  return { ok: true };
}

export async function create(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => createInTx(tx, context, namespaceId, prepared));
}
export async function update(
  db: DB,
  context: ServiceContext,
  namespaceId: string,
  warpId: string,
  body: Record<string, unknown>,
) {
  const prepared = prepareInput(body);
  return withTx(db, (tx) => updateInTx(tx, context, namespaceId, warpId, prepared));
}
export async function remove(db: DB, context: ServiceContext, namespaceId: string, warpId: string) {
  return withTx(db, (tx) => removeInTx(tx, context, namespaceId, warpId));
}
