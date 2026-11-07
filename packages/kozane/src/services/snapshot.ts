import { snapshot as service } from "@kozane/core/services";
export const readRows: typeof service.readRows = service.readRows;
export const assemble: typeof service.assemble = service.assemble;
export const get: typeof service.get = service.get;
export type SnapshotRows = service.SnapshotRows;
export type SnapshotEnrichment = service.SnapshotEnrichment;
