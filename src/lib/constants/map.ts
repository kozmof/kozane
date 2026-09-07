/**
 * The map page's own bounds: how much of the tag graph is sent to it, and the box it packs
 * into before a browser has measured one.
 */
/**
 * How many (tag, bundle) pairs the map page's tag graph carries.
 *
 * The page draws one selected tag's lines at a time, but it is sent the whole index at once,
 * because the tree beside it is the whole index and clicking down it must not be a round trip
 * per row. That index is an aggregate — one entry per tag per bundle, however many cards
 * made it — so it is far smaller than the up-to-{@link TAG_CARD_HITS_MAX} hits it is built
 * from, and in a workspace of any ordinary shape it never approaches this.
 *
 * It is bounded anyway, for the reason every other ceiling on the tag path exists: "one entry
 * per tag per bundle" is a product of two quantities the code does not know, and a tag
 * written into a template that seeds every card of every bundle multiplies them. Reaching it
 * is reported rather than silently absorbed — see `tagLinksTruncated` on the map loader —
 * because a graph missing lines and a graph whose tag genuinely reaches nowhere else look
 * identical.
 */
export const MAP_TAG_LINKS_MAX = 20_000;

/**
 * The area the map's packing is computed against when nothing has measured a real one, in CSS
 * pixels.
 *
 * A treemap is a function of the rectangle it fills, and the server has no rectangle: it
 * renders the page before any browser has laid it out, and `kozane net ssg generate` renders
 * it on a machine with no browser at all. Without a fallback both would have to emit an empty
 * `<svg>` and wait for hydration, which in a static export means a page that shows nothing to
 * a reader with JavaScript off.
 *
 * So the server packs at this size and the browser repacks at the size it measures, through
 * the same pure function. A common desktop viewport less the tag panel, chosen so the served
 * HTML is a map someone could read as it stands rather than a placeholder — the layout that
 * replaces it on mount is the same map at another size, not a different one.
 */
export const MAP_DEFAULT_VIEWPORT = { width: 1600, height: 1000 } as const;
