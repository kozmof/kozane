const MIN_SHORT_ID_LENGTH = 8;

function compact(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

export function shortId(id: string, allIds: string[]): string {
  const normalized = compact(id);
  for (
    let length = Math.min(MIN_SHORT_ID_LENGTH, normalized.length);
    length < normalized.length;
    length++
  ) {
    const suffix = normalized.slice(-length);
    if (allIds.filter((candidate) => compact(candidate).endsWith(suffix)).length === 1)
      return suffix;
  }
  return normalized;
}

export function resolveShortId(input: string, allIds: string[], label: string): string {
  const exact = allIds.find((id) => id.toLowerCase() === input.toLowerCase());
  if (exact) return exact;

  const normalized = compact(input);
  const matches = allIds.filter((id) => compact(id).endsWith(normalized));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`${label} not found: ${input}`);
  throw new Error(`Ambiguous ${label.toLowerCase()} ID: ${input}. Use more characters.`);
}
