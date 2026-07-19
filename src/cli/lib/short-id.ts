const MIN_SHORT_ID_LENGTH = 4;
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
