import type { TagsViewPageData } from "../backend/views/tags.js";
/** Older exports may omit scan-warning fields. */
export type TagsPageData = Omit<TagsViewPageData, "missing" | "cardsTruncated"> &
  Partial<Pick<TagsViewPageData, "missing" | "cardsTruncated">>;
export interface TagsSelection {
  tag: string | null;
  namespaceId: string | null;
}
