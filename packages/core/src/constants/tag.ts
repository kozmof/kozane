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
