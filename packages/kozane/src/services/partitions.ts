import { partitions as service } from "@kozane/core/services";
export const create: typeof service.create = service.create;
export const rename: typeof service.rename = service.rename;
export const remove: typeof service.remove = service.remove;
export type PartitionCreateInput = service.PartitionCreateInput;
export type PartitionRenameInput = service.PartitionRenameInput;
