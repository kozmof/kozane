import { records } from "@kozane/core/database";
export const columnCount: typeof records.utils.columnCount = records.utils.columnCount;
export const readByIds: typeof records.utils.readByIds = records.utils.readByIds;
export const assertNameWithinLimit: typeof records.utils.assertNameWithinLimit =
  records.utils.assertNameWithinLimit;
export const assertFound: typeof records.utils.assertFound = records.utils.assertFound;
export const isUniqueConstraintError: typeof records.utils.isUniqueConstraintError =
  records.utils.isUniqueConstraintError;
export const isForeignKeyError: typeof records.utils.isForeignKeyError =
  records.utils.isForeignKeyError;
export type BatchRejection = records.utils.BatchRejection;
export type BatchRefusal<R extends BatchRejection> = records.utils.BatchRefusal<R>;
export type BatchResult<
  R extends BatchRejection,
  Ok extends object = Record<never, never>,
> = records.utils.BatchResult<R, Ok>;
export type CardBatchResult = records.utils.CardBatchResult;
export const NotFoundError: typeof records.utils.NotFoundError = records.utils.NotFoundError;
export type NotFoundError = records.utils.NotFoundError;
export const DefaultPartitionError: typeof records.utils.DefaultPartitionError =
  records.utils.DefaultPartitionError;
export type DefaultPartitionError = records.utils.DefaultPartitionError;
export const DefaultLayerError: typeof records.utils.DefaultLayerError =
  records.utils.DefaultLayerError;
export type DefaultLayerError = records.utils.DefaultLayerError;
