import { glues as service } from "@kozane/core/services";
export const createInTx: typeof service.createInTx = service.createInTx;
export const removeInTx: typeof service.removeInTx = service.removeInTx;
export const create: typeof service.create = service.create;
export const remove: typeof service.remove = service.remove;
export type GlueCreateInput = service.GlueCreateInput;
export type GlueRemoveInput = service.GlueRemoveInput;
