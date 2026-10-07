import { getUiConfigForRoot, getWorkspaceUiConfig } from "../../db/internal/config.js";

/**
 * Read the workspace's configured card text limit. Server callers resolve the root from the
 * environment, while CLI callers can supply it explicitly.
 */
export function contentMax(): number {
  return getWorkspaceUiConfig().contentMax;
}

/** Read the card text limit for an explicit workspace root. */
export function contentMaxForRoot(root: string): number {
  return getUiConfigForRoot(root).contentMax;
}

/**
 * Reserve space for request fields other than card text, including IDs, position, and JSON
 * syntax.
 */
const BODY_ENVELOPE_BYTES = 64 * 1024;

/**
 * Maximum bytes per JSON-escaped UTF-16 code unit. A control-character escape takes six
 * bytes, compared with three for a CJK character or four for an emoji's two code units.
 */
const WORST_BYTES_PER_UNIT = 6;

/**
 * Compute an HTTP body allowance large enough for accepted card text. Account for worst-case
 * JSON escaping so transport limits do not reject text the endpoint would store.
 */
export function bodySizeLimitFor(contentMax: number): number {
  return contentMax * WORST_BYTES_PER_UNIT + BODY_ENVELOPE_BYTES;
}
