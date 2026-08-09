/**
 * Characters a displayed short ID starts at, before being lengthened to break a
 * collision. Exported so callers and tests read the current width instead of
 * hardcoding it. Shorter input is still accepted by `resolveShortId`, which
 * matches any unambiguous prefix regardless of this value.
 */
export const MIN_SHORT_ID_LENGTH = 7;
const SHORT_ID_KEY_LENGTH = 12;

function compact(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

function shortIdKey(id: string): string {
  return compact(id).slice(-SHORT_ID_KEY_LENGTH);
}

export function shortId(id: string, allIds: string[]): string {
  const key = shortIdKey(id);
  for (let length = Math.min(MIN_SHORT_ID_LENGTH, key.length); length <= key.length; length++) {
    const prefix = key.slice(0, length);
    if (allIds.filter((candidate) => shortIdKey(candidate).startsWith(prefix)).length === 1)
      return prefix;
  }
  return compact(id);
}

/**
 * Short IDs for a whole set at once.
 *
 * `shortId` rescans `allIds` at every prefix length, so calling it per row is
 * quadratic; this builds one prefix-count table and resolves each id by lookup.
 * Results are identical to calling `shortId(id, allIds)` for each id.
 */
export function shortIdMap(allIds: string[]): Map<string, string> {
  const keyed = allIds.map((id) => [id, shortIdKey(id)] as const);

  const prefixCounts = new Map<string, number>();
  for (const [, key] of keyed) {
    for (let length = Math.min(MIN_SHORT_ID_LENGTH, key.length); length <= key.length; length++) {
      const prefix = key.slice(0, length);
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }

  const shortIds = new Map<string, string>();
  for (const [id, key] of keyed) {
    let resolved = compact(id);
    for (let length = Math.min(MIN_SHORT_ID_LENGTH, key.length); length <= key.length; length++) {
      const prefix = key.slice(0, length);
      if (prefixCounts.get(prefix) === 1) {
        resolved = prefix;
        break;
      }
    }
    shortIds.set(id, resolved);
  }
  return shortIds;
}

export function resolveShortId(input: string, allIds: string[], label: string): string {
  const normalized = compact(input);
  const exact = allIds.find((id) => compact(id) === normalized);
  if (exact) return exact;

  const matches =
    normalized.length <= SHORT_ID_KEY_LENGTH
      ? allIds.filter((id) => shortIdKey(id).startsWith(normalized))
      : [];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`${label} not found: ${input}`);
  throw new Error(`Ambiguous ${label.toLowerCase()} ID: ${input}. Use more characters.`);
}
