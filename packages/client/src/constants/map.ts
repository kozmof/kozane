/** Bounds for the map's tag graph and its layout before browser measurements are available. */
/**
 * Maximum tag and partition pairs sent to the map. Report truncation when the limit is
 * reached so missing graph links are not mistaken for absent relationships.
 */
export const MAP_TAG_LINKS_MAX = 20_000;

/**
 * Fallback map dimensions for server rendering before a browser measures the viewport. Render
 * a usable treemap immediately, then recompute layout at the measured size.
 */
export const MAP_DEFAULT_VIEWPORT = { width: 1600, height: 1000 } as const;
