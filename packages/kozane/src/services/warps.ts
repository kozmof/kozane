import { warps as service } from "@kozane/core/services";
export const createInTx: typeof service.createInTx = service.createInTx;
export const updateInTx: typeof service.updateInTx = service.updateInTx;
export const removeInTx: typeof service.removeInTx = service.removeInTx;
export const create: typeof service.create = service.create;
export const update: typeof service.update = service.update;
export const remove: typeof service.remove = service.remove;
export type WarpCreateInput = service.WarpCreateInput;
export type WarpUpdateInput = service.WarpUpdateInput;
