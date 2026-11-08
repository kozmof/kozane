import { rejection as service } from "@kozane/core/services";
export const BatchValidationError: typeof service.BatchValidationError =
  service.BatchValidationError;
export const rejectBatch: typeof service.rejectBatch = service.rejectBatch;
export type BatchValidationError = service.BatchValidationError;
