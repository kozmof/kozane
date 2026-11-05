import { createNodeNavigation } from "$lib/navigation.js";
/** Namespace, tag, and day filters. Null omits a filter from the URL. */
export type MapQuery = {
  namespaceId: string | null;
  tag: string | null;
  day: string | null;
};

/** Build a map URL from namespace, tag, and day filters in fixed parameter order. */
export function mapHref(base: string, { namespaceId, tag, day }: MapQuery): string {
  return createNodeNavigation({ base }).map({ namespaceId, tag, day });
}
