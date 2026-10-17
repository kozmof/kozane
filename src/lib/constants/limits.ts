/**
 * Limits for card text, names, rows, and SQL parameters. Keep batching helpers beside the
 * limits they enforce.
 */
/**
 * Default card text limit in UTF-16 code units. Read the workspace's `ui.contentMax` setting
 * and pass it to {@link contentLimitIssue} when validating writes.
 *
 * `bin/server.js` sizes the HTTP body allowance through {@link bodySizeLimitFor} so accepted
 * card text can reach the endpoint.
 */
export const CONTENT_MAX = 200_000;
/**
 * Return a shared validation message when text exceeds `contentMax`, or null when it fits.
 * Pass the limit explicitly so CLI and HTTP callers can use their workspace settings.
 */
export function contentLimitIssue(content: string, contentMax: number): string | null {
  return content.length > contentMax
    ? `content must be a string under ${contentMax} characters`
    : null;
}

export type CardContentCheck = { ok: true; content: string } | { ok: false; issue: string };

/**
 * Trim card text and check it is nonblank and within `contentMax`. Share this between HTTP
 * routes and CLI commands so every writer stores card text under the same rules.
 */
export function checkCardContent(raw: string, contentMax: number): CardContentCheck {
  const content = raw.trim();
  if (!content) return { ok: false, issue: "content must not be empty" };
  const issue = contentLimitIssue(content, contentMax);
  return issue ? { ok: false, issue } : { ok: true, content };
}
export const NAME_MAX = 255;
/**
 * Maximum IDs a request may name. This limits request work but does not size multi-parameter
 * write statements, which use {@link STATEMENT_PARAMS_MAX} separately.
 */
export const BATCH_MAX = 2_000;
/**
 * Default maximum rows per insert chunk. Multi-column inserts also account for their
 * parameter count.
 */
export const INSERT_CHUNK_MAX = 200;

/**
 * Bound parameters allowed per generated statement. Size chunks from actual row width,
 * including CASE updates that bind IDs and values multiple times per row.
 */
export const STATEMENT_PARAMS_MAX = 2_000;

/**
 * Split rows into chunks no larger than {@link INSERT_CHUNK_MAX}. When `columnsPerRow` is
 * supplied, also keep each statement within {@link STATEMENT_PARAMS_MAX}.
 */
export function chunked<T>(
  rows: T[],
  { size = INSERT_CHUNK_MAX, columnsPerRow }: { size?: number; columnsPerRow?: number } = {},
): T[][] {
  const affordable = columnsPerRow
    ? Math.max(1, Math.floor(STATEMENT_PARAMS_MAX / columnsPerRow))
    : size;
  const batchSize = Math.min(size, affordable);
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += batchSize)
    chunks.push(rows.slice(start, start + batchSize));
  return chunks;
}
