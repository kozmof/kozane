/**
 * Validate mutation response fields before applying them to board state. Return undefined for
 * missing or invalid values so callers can report failure and roll back rather than storing
 * unchecked JSON values.
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
 * Read a string that may be empty, such as card text or a layer name. Unlike {@link
 * readString}, do not treat empty strings as absent. Return `undefined` for absent or
 * non-string values.
 */
export function readText(source: unknown, key: string): string | undefined {
  const value = record(source)?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Read a finite number suitable for storage and rendering. Reject infinities and NaN, as
 * `optionalNumber` does for requests.
 */
export function readFiniteNumber(source: unknown, key: string): number | undefined {
  const value = record(source)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(source: unknown, key: string): boolean | undefined {
  const value = record(source)?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Read a string or a valid null value. Return undefined for invalid input. */
export function readNullableString(source: unknown, key: string): string | null | undefined {
  const value = record(source)?.[key];
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * Read a number or a valid null value. Return undefined for invalid input. A null card width
 * uses the workspace default.
 */
export function readNullableFiniteNumber(source: unknown, key: string): number | null | undefined {
  const value = record(source)?.[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Validate a list through the caller's item reader. */
export function readArray(source: unknown, key: string): unknown[] | undefined {
  const value = record(source)?.[key];
  return Array.isArray(value) ? value : undefined;
}

/** Reject the entire list if any element is invalid. */
export function readStringArray(source: unknown, key: string): string[] | undefined {
  const value = record(source)?.[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string" && item.length > 0)
    ? (value as string[])
    : undefined;
}
