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
