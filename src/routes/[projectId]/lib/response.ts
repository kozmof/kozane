/**
 * Readers for the JSON a mutation answers with.
 *
 * The mirror of `request.ts`: that one guards what arrives at an endpoint, and this guards
 * what comes back from one. `Response.json()` resolves to `any`, so the action layer read
 * its results straight off it — `parsed.id`, `parsed.defaultLayerId`, `parsed.position` —
 * and a body without those fields wrote `undefined` into board state rather than failing.
 * A bundle with no id, an `activeLayerId` of `undefined`: both survive to the next poll,
 * and neither says anything about what went wrong.
 *
 * Every reader answers `undefined` for "absent, or not that type", which is the single
 * answer callers act on — they roll the board back and raise the banner they already have,
 * exactly as they do for a failed request. The narrowing is real, so the values that come
 * out need no casts.
 */

function record(source: unknown): Record<string, unknown> | undefined {
  if (typeof source !== "object" || source === null || Array.isArray(source)) return undefined;
  return source as Record<string, unknown>;
}

export function readString(source: unknown, key: string): string | undefined {
  const value = record(source)?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A string field that is allowed to be empty, unlike {@link readString}, which treats an
 * empty string as absent because every field it reads is an id.
 *
 * Card text and layer names are the cases: a card with no text yet is an ordinary card the
 * board draws as "Empty card…", and refusing it here would drop the whole snapshot it
 * arrived in. `undefined` still means "absent, or not a string".
 */
export function readText(source: unknown, key: string): string | undefined {
  const value = record(source)?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * A number that can be stored and drawn with. Infinities and `NaN` are refused for the
 * reason `optionalNumber` refuses them on the way in: they travel through JSON as `null`
 * or arrive from a hand-made body, and either one puts a card at `NaN` on the canvas.
 */
export function readFiniteNumber(source: unknown, key: string): number | undefined {
  const value = record(source)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(source: unknown, key: string): boolean | undefined {
  const value = record(source)?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A string field that may legitimately be `null` — a warp hint for a card with no text is
 * the case that needs it. `undefined` still means "not valid", so the two stay distinct.
 */
export function readNullableString(source: unknown, key: string): string | null | undefined {
  const value = record(source)?.[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * The {@link readNullableString} of numbers: `null` is a value, `undefined` a refusal.
 * `card.width` is the field that needs it — null is a card following `ui.defaultCardWidth`.
 */
export function readNullableFiniteNumber(source: unknown, key: string): number | null | undefined {
  const value = record(source)?.[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A list whose elements are read one at a time, for the responses that carry rows rather
 * than scalars. Unlike {@link readStringArray} this says nothing about the elements —
 * the caller reads each with the readers above.
 */
export function readArray(source: unknown, key: string): unknown[] | undefined {
  const value = record(source)?.[key];
  return Array.isArray(value) ? value : undefined;
}

/** All or nothing: one bad element makes the whole list untrustworthy, so none is returned. */
export function readStringArray(source: unknown, key: string): string[] | undefined {
  const value = record(source)?.[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string" && item.length > 0)
    ? (value as string[])
    : undefined;
}
