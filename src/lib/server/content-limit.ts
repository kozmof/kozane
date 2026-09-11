import { getUiConfigForRoot, getWorkspaceUiConfig } from "../../db/internal/config.js";

/**
 * How much text one card of this workspace may hold. Sized by `ui.contentMax`, so the
 * built-in `CONTENT_MAX` default is the right answer only for a workspace that has not
 * changed it: a caller holding the constant would refuse text a workspace that raised the
 * setting means to accept, and accept text one that lowered it means to refuse.
 *
 * Split the way `canvasBounds` is, and for the same reason — the server finds its
 * workspace from the environment, the CLI has already resolved a root of its own.
 */
export function contentMax(): number {
  return getWorkspaceUiConfig().contentMax;
}

/** The same limit, for a caller that already holds the workspace root — the CLI. */
export function contentMaxForRoot(root: string): number {
  return getUiConfigForRoot(root).contentMax;
}

/**
 * Room for everything in the request that is not the card's text: the ids, the position,
 * the headers of the JSON around it. Generous, because it is paid once per request and the
 * point of the figure below is to be impossible to hit by accident.
 */
const BODY_ENVELOPE_BYTES = 64 * 1024;

/**
 * The most bytes one JSON-escaped UTF-16 code unit can become. A control character is the
 * worst case: `` is six bytes for one unit, where a CJK character is three and an
 * emoji is four across the two units it takes.
 */
const WORST_BYTES_PER_UNIT = 6;

/**
 * How large an HTTP body has to be allowed to get for a card of `contentMax` characters to
 * reach the endpoint that would accept it.
 *
 * adapter-node refuses a body past `BODY_SIZE_LIMIT`, which defaults to 512K — a ceiling
 * lower than a single card once `ui.contentMax` is raised anywhere near its own maximum,
 * and one no endpoint names. Left alone, the browser is refused by the transport for text
 * the server would have stored, with a status the composer can only report as a failure;
 * the CLI, which writes to the database directly, takes the same card without complaint.
 * So the transport is sized from the limit rather than the other way round.
 *
 * Counted at the worst byte cost an escaped character can reach rather than at the three
 * bytes ordinary Japanese text costs: the figure is a ceiling on what is refused, not a
 * budget anyone spends, and a local server holding a few megabytes for the length of one
 * request is cheaper than a card that cannot be saved and does not say why.
 */
export function bodySizeLimitFor(contentMax: number): number {
  return contentMax * WORST_BYTES_PER_UNIT + BODY_ENVELOPE_BYTES;
}
