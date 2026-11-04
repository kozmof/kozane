export { NotFoundError, DefaultPartitionError, DefaultLayerError } from "../db/api/utils.js";
export class ValidationError extends Error {
  override name = "ValidationError";
}
export class ConflictError extends Error {
  override name = "ConflictError";
}
export class LimitError extends Error {
  override name = "LimitError";
}
export class UnavailableError extends Error {
  override name = "UnavailableError";
}
