import { cards as service } from "@kozane/core/services";
import { composeWrite } from "../db/database.js";
import { completeImageUploadsInTx } from "../db/api/image-upload.js";
export const createInTx: typeof service.createInTx = async (tx, ...args) => {
  const result = await service.createInTx(tx, ...args);
  await completeImageUploadsInTx(tx);
  return result;
};
export const create: typeof service.create = (db, ...args) =>
  composeWrite(db, (tx) => createInTx(tx, ...args));
export const updatePositionsInTx: typeof service.updatePositionsInTx = service.updatePositionsInTx;
export const removeInTx: typeof service.removeInTx = service.removeInTx;
export const moveInTx: typeof service.moveInTx = service.moveInTx;
export const setLayerInTx: typeof service.setLayerInTx = service.setLayerInTx;
export const setPartitionInTx: typeof service.setPartitionInTx = service.setPartitionInTx;
export const setStacking: typeof service.setStacking = service.setStacking;
export const updateInTx: typeof service.updateInTx = async (tx, ...args) => {
  const result = await service.updateInTx(tx, ...args);
  await completeImageUploadsInTx(tx);
  return result;
};
export const update: typeof service.update = (db, ...args) =>
  composeWrite(db, (tx) => updateInTx(tx, ...args));
export const removeOne: typeof service.removeOne = service.removeOne;
export const squash: typeof service.squash = service.squash;
export const updatePositions: typeof service.updatePositions = service.updatePositions;
export const setLayer: typeof service.setLayer = service.setLayer;
export const remove: typeof service.remove = service.remove;
export const move: typeof service.move = service.move;
export const setPartition: typeof service.setPartition = service.setPartition;
export type CardCreateInput = service.CardCreateInput;
export type CardUpdateFields = service.CardUpdateFields;
export type CardUpdateInput = service.CardUpdateInput;
export type CardUpdatePositionsInput = service.CardUpdatePositionsInput;
export type CardRemoveInput = service.CardRemoveInput;
export type CardMoveInput = service.CardMoveInput;
export type CardSetLayerInput = service.CardSetLayerInput;
export type CardSetPartitionInput = service.CardSetPartitionInput;
export type CardSetStackingInput = service.CardSetStackingInput;
export type CardSquashInput = service.CardSquashInput;

export const removeOneInTx = service.removeOneInTx;
export const setStackingInTx = service.setStackingInTx;
export const squashInTx = service.squashInTx;
