import type { MapViewData } from "../../backend/views/map.js";
/** Older exports may omit the card-scan warning. */
export type MapPageData = Omit<MapViewData, "cardsTruncated"> &
  Partial<Pick<MapViewData, "cardsTruncated">>;
export interface MapSelection {
  namespaceId: string | null;
  tag: string | null;
  day: string | null;
}
