/** The three things a map URL can narrow to. Null leaves that one off. */
export type MapQuery = {
  namespaceId: string | null;
  tag: string | null;
  day: string | null;
};

/**
 * A link to the map, narrowed by `query`.
 *
 * The page links to itself with one of the three changed and the other two carried over, so
 * every one of its links comes through here. The parameter order is fixed — namespace, tag,
 * day — so a link built from any of them spells the same narrowing the same way.
 */
export function mapHref(base: string, { namespaceId, tag, day }: MapQuery): string {
  const params = new URLSearchParams();
  if (namespaceId) params.set("namespaceId", namespaceId);
  if (tag) params.set("tag", tag);
  if (day) params.set("day", day);
  const query = params.toString();
  return query ? `${base}/map?${query}` : `${base}/map`;
}
