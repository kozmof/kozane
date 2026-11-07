/** The character that opens a tag. See `lib/tag.ts` for the grammar it starts. */
export const TAG_SIGIL = ":";

/**
 * Maximum characters per tag segment. Reject longer candidates instead of truncating them.
 * This also limits accidental tags in text written without spaces.
 */
export const TAG_SEGMENT_CHARS_MAX = 64;

/** Maximum tag depth. For example, `:foo:bar:baz` has three levels. */
export const TAG_LEVELS_MAX = 8;

/**
 * Maximum excerpt length for a tag hit. Keep enough text to identify the match without
 * copying the full source into the index.
 */
export const TAG_EXCERPT_CHARS_MAX = 200;

/**
 * Maximum card hits gathered across the workspace. Bound the result array, derived tree, and
 * serialized payload, matching the file-side hit limit.
 */
export const TAG_CARD_HITS_MAX = 100_000;

/**
 * Maximum card rows held per tag-query page. Page by ID to bound memory while continuing
 * until the hit limit or end of results. A fixed row cap would miss tags after prefilter
 * matches that yield no hits.
 */
export const TAG_CARD_ROWS_PAGE = 1_000;
