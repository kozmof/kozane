import { layers as service } from "@kozane/core/services";
export const create: typeof service.create = service.create;
export const rename: typeof service.rename = service.rename;
export const remove: typeof service.remove = service.remove;
export const reorderInTx: typeof service.reorderInTx = service.reorderInTx;
export const reorder: typeof service.reorder = service.reorder;
export type LayerCreateInput = service.LayerCreateInput;
export type LayerRenameInput = service.LayerRenameInput;
export type LayerReorderInput = service.LayerReorderInput;
