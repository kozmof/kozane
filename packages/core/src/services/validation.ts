import { ValidationError } from "./errors.js";
import { BATCH_MAX, NAME_MAX } from "../constants/index.js";

type JsonRecord = Record<string, unknown>;

/**
 * Reject arrays larger than {@link BATCH_MAX} before building database statements.
 */
export function requireWithinBatchLimit(length: number, key: string): void {
  if (length > BATCH_MAX) throw new ValidationError(`${key} must have at most ${BATCH_MAX} items`);
}

export function requireTrimmedString(
  body: JsonRecord,
  key: string,
  message = `${key} is required`,
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(message);
  return value.trim();
}

/**
 * Read a required, trimmed, nonblank name within {@link NAME_MAX}. Report invalid names as
 * request errors, while database helpers enforce the same limit for non-HTTP callers.
 */
export function requireBoundedName(body: JsonRecord, key = "name"): string {
  const name = requireTrimmedString(body, key);
  if (name.length > NAME_MAX)
    throw new ValidationError(`${key} must be ${NAME_MAX} characters or fewer`);
  return name;
}

export function requireString(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0)
    throw new ValidationError(`${key} is required`);
  return value;
}

export function optionalString(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${key} must be a string`);
  return value;
}

/**
 * Read an optional reference such as an ID. Unlike {@link optionalString}, refuse `""`, which
 * would otherwise read as "not given" and quietly fall back to a default.
 */
export function optionalId(body: JsonRecord, key: string): string | undefined {
  const value = optionalString(body, key);
  if (value === "") throw new ValidationError(`${key} must be a non-empty string`);
  return value;
}

export function optionalNumber(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ValidationError(`${key} must be a number`);
  return value;
}

/**
 * Read an optional number while distinguishing null from omission. For card width, null
 * restores the configured default and omission preserves the current value.
 */
export function optionalNullableNumber(body: JsonRecord, key: string): number | null | undefined {
  if (body[key] === null) return null;
  return optionalNumber(body, key);
}

/** Read a required finite number. */
export function requireFiniteNumber(body: JsonRecord, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ValidationError(`${key} must be a number`);
  return value;
}

/**
 * Read an array of objects with shared request guards. Check shape, required length, and
 * batch size before validating individual items through `readItem`.
 *
 * Allow a custom message to preserve endpoint-specific wording for missing or non-array
 * fields.
 */
export function requireObjectArray<T>(
  body: JsonRecord,
  key: string,
  readItem: (item: JsonRecord) => T,
  { minLength = 1, message = `${key} must be an array` } = {},
): T[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length < minLength) throw new ValidationError(message);
  requireWithinBatchLimit(value.length, key);
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new ValidationError(`${key} must contain objects`);
    return readItem(item as JsonRecord);
  });
}

export function requireStringArray(body: JsonRecord, key: string, minLength = 1): string[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new ValidationError(`${key} must be an array`);
  if (value.length < minLength)
    throw new ValidationError(
      `${key} must have at least ${minLength} item${minLength === 1 ? "" : "s"}`,
    );
  // Reject oversized batches before checking item types and duplicates.
  requireWithinBatchLimit(value.length, key);
  if (value.some((item) => typeof item !== "string" || item.length === 0))
    throw new ValidationError(`${key} must contain non-empty strings`);
  requireUniqueStrings(value, key);
  return value;
}

export function requireUniqueStrings(values: string[], key: string): void {
  if (new Set(values).size !== values.length) throw new ValidationError(`${key} must be unique`);
}

/**
 * Read an optional name that may be empty, trimmed and within {@link NAME_MAX}. Inventories
 * work without a name, so a blank one is not an error the way it is for a partition.
 */
export function optionalBoundedName(body: JsonRecord, key = "name"): string | undefined {
  const value = optionalString(body, key);
  if (value === undefined) return undefined;
  const name = value.trim();
  if (name.length > NAME_MAX)
    throw new ValidationError(`${key} must be ${NAME_MAX} characters or fewer`);
  return name;
}
