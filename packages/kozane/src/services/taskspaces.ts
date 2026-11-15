import { taskspaces as service } from "@kozane/core/services";
export const create: typeof service.create = service.create;
export const createInTx: typeof service.createInTx = service.createInTx;
export const rename: typeof service.rename = service.rename;
export const renameInTx: typeof service.renameInTx = service.renameInTx;
export const remove: typeof service.remove = service.remove;
export const removeInTx: typeof service.removeInTx = service.removeInTx;
