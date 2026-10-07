/** The three things a map URL can narrow to. Null leaves that one off. */
export type MapQuery = {
  namespaceId: string | null;
  tag: string | null;
  day: string | null;
};

/** Build a map URL from namespace, tag, and day filters in fixed parameter order. */
export function mapHref(base: string, { namespaceId, tag, day }: MapQuery): string {
  const params = new URLSearchParams();
  if (namespaceId) params.set("namespaceId", namespaceId);
  if (tag) params.set("tag", tag);
  if (day) params.set("day", day);
  const query = params.toString();
  return query ? `${base}/map?${query}` : `${base}/map`;
}
