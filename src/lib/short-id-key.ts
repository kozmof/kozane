/**
 * How short IDs relate to full IDs. Shared by the CLI, which prints and resolves short IDs,
 * and by config lookups that accept them, such as `taskspace.namespacePaths`.
 *
 * UUIDv7 IDs made close together share their leading timestamp, so short IDs are taken from
 * the random tail instead: a prefix of the last {@link SHORT_ID_KEY_LENGTH} hex digits.
 */
export const SHORT_ID_KEY_LENGTH = 12;

/**
 * Minimum displayed short-ID length. Extend it to resolve collisions. `resolveShortId`
 * accepts any unambiguous prefix, including shorter input, but config keys must be at least
 * this long, so a word made of hex letters such as `cafe` is not taken for an ID.
 */
export const MIN_SHORT_ID_LENGTH = 7;

/** The ID without dashes, in lower case. */
export function compactId(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

/** The part of an ID that short IDs are prefixes of. */
export function shortIdKey(id: string): string {
  return compactId(id).slice(-SHORT_ID_KEY_LENGTH);
}

/**
 * Whether `input` names `id`: the full ID, with or without dashes, or a short ID as the CLI
 * prints it. An empty input matches nothing.
 */
export function idMatches(input: string, id: string): boolean {
  const normalized = compactId(input);
  if (!normalized) return false;
  if (normalized === compactId(id)) return true;
  return normalized.length <= SHORT_ID_KEY_LENGTH && shortIdKey(id).startsWith(normalized);
}
