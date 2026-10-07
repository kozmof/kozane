import { error } from "@sveltejs/kit";
import { BATCH_MAX, NAME_MAX } from "$lib/constants";

type JsonRecord = Record<string, unknown>;

/**
 * Guards a request array against {@link BATCH_MAX} before anything is done with it, so an
 * oversized body is refused while it is still just a list rather than partway into a
 * statement SQLite will not accept.
 */
export function requireWithinBatchLimit(length: number, key: string): void {
  if (length > BATCH_MAX) throw error(400, `${key} must have at most ${BATCH_MAX} items`);
}

/**
 * Require `application/json` and read an object body. This forces cross-origin browser
 * requests through CORS preflight instead of accepting simple requests that `request.json()`
 * could otherwise parse.
 */
export async function readJsonObject(request: Request): Promise<JsonRecord> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw error(415, "Request body must be sent as application/json");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, "Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw error(400, "Request body must be a JSON object");
  }
  return body as JsonRecord;
}

export function requireTrimmedString(
  body: JsonRecord,
  key: string,
  message = `${key} is required`,
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw error(400, message);
  return value.trim();
}

/**
 * Read a required, trimmed, nonblank name within {@link NAME_MAX}. Report invalid names as
 * request errors, while database helpers enforce the same limit for non-HTTP callers.
 */
export function requireBoundedName(body: JsonRecord, key = "name"): string {
  const name = requireTrimmedString(body, key);
  if (name.length > NAME_MAX) throw error(400, `${key} must be ${NAME_MAX} characters or fewer`);
  return name;
}

export function requireString(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw error(400, `${key} is required`);
  return value;
}

export function optionalString(body: JsonRecord, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw error(400, `${key} must be a string`);
  return value;
}

export function optionalNumber(body: JsonRecord, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw error(400, `${key} must be a number`);
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
    throw error(400, `${key} must be a number`);
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
  if (!Array.isArray(value) || value.length < minLength) throw error(400, message);
  requireWithinBatchLimit(value.length, key);
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw error(400, `${key} must contain objects`);
    return readItem(item as JsonRecord);
  });
}

export function requireStringArray(body: JsonRecord, key: string, minLength = 1): string[] {
  const value = body[key];
  if (!Array.isArray(value)) throw error(400, `${key} must be an array`);
  if (value.length < minLength)
    throw error(400, `${key} must have at least ${minLength} item${minLength === 1 ? "" : "s"}`);
  // Checked before the per-item work below, which is what an oversized body would otherwise
  // pay for twice over.
  requireWithinBatchLimit(value.length, key);
  if (value.some((item) => typeof item !== "string" || item.length === 0))
    throw error(400, `${key} must contain non-empty strings`);
  requireUniqueStrings(value, key);
  return value;
}

export function requireUniqueStrings(values: string[], key: string): void {
  if (new Set(values).size !== values.length) throw error(400, `${key} must be unique`);
}
