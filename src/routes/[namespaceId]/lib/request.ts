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

export async function readJsonObject(request: Request): Promise<JsonRecord> {
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
 * A user-supplied name: present, non-blank once trimmed, and within {@link NAME_MAX}.
 *
 * The two halves belong together. `assertNameWithinLimit` in `db/api/utils.ts` holds the
 * same limit for callers that never reach a route — the CLI above all — but it throws,
 * which over HTTP is a 500 for what is plainly a bad request. So every endpoint taking a
 * name checked the length itself, in six places, with the message written out six times.
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
 * A number field that may also arrive as `null`. Null is a value here — "this card has no
 * width of its own" — where `undefined` means "leave whatever it has alone", which is the
 * distinction {@link optionalNumber} cannot make on its own. `card.width` is the only
 * field that needs it: null is how a resized card goes back to `ui.defaultCardWidth`.
 */
export function optionalNullableNumber(body: JsonRecord, key: string): number | null | undefined {
  if (body[key] === null) return null;
  return optionalNumber(body, key);
}

/**
 * A number field that must be there, as the counterpart to {@link optionalNumber}.
 *
 * The one this module was missing. Every optional field had a reader and every required
 * string had one, so a required *number* was the gap that got filled in place — the
 * position batch below spelled `typeof row.posX !== "number" || !Number.isFinite(row.posX)`
 * twice, once per axis, with the message written out beside each.
 */
export function requireFiniteNumber(body: JsonRecord, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw error(400, `${key} must be a number`);
  return value;
}

/**
 * Each element of an array field, read through the same guards as a top-level body.
 *
 * This module guarded request bodies and the string arrays in them, and nothing else: an
 * array of *objects* — `positions` on `PATCH /cards` is the only one — was checked inside
 * the route, longhand, with its own `Array.isArray`, its own per-item `typeof` ladder and
 * its own four messages. That is the gap, rather than the duplication: a second endpoint
 * taking a batch of objects had no reader to reach for and would have grown another ladder,
 * and `requireWithinBatchLimit` is easy to leave out of a hand-written one, which is the
 * check standing between a request and a statement SQLite refuses.
 *
 * `readItem` is handed a `JsonRecord` and reads it with the same `require*` functions a
 * route reads a body with, so an element gets the vocabulary and the messages everything
 * else gets. The order here is load-bearing and matches {@link requireStringArray}: shape,
 * then length, then the batch limit, then the per-item work — the limit is what an
 * oversized body must be refused by *before* anything iterates it.
 *
 * `message` exists because "this field is required" and "this field is not an array" are
 * the same answer to a caller who sent neither, and `positions` worded it the first way
 * before this reader existed. Keeping that wording is the point of the parameter.
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
