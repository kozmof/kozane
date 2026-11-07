import {
  ValidationError,
  NotFoundError,
  ConflictError,
  DefaultLayerError,
  DefaultPartitionError,
  LimitError,
  UnavailableError,
} from "./errors.js";

export type DomainErrorCode = "validation" | "not_found" | "conflict" | "limit" | "unavailable";
export function domainErrorCode(error: unknown): DomainErrorCode | undefined {
  if (
    error instanceof ValidationError ||
    error instanceof DefaultLayerError ||
    error instanceof DefaultPartitionError
  )
    return "validation";
  if (error instanceof NotFoundError) return "not_found";
  if (error instanceof ConflictError) return "conflict";
  if (error instanceof LimitError) return "limit";
  if (error instanceof UnavailableError) return "unavailable";
  return undefined;
}
