import { and, asc, eq, gt, like, type SQL } from "drizzle-orm";
import { partitionTable, cardTable } from "../schema.js";
import type { NeedsDB } from "./types.js";
import type { TagHit } from "../../lib/types.js";
import { scanTagLines } from "../../lib/tag.js";
import { TAG_CARD_HITS_MAX, TAG_CARD_ROWS_PAGE, TAG_SIGIL } from "../../lib/constants.js";

export type CardTagHits = {
  hits: TagHit[];
  /**
   * The map-facing dimensions of each tagged card, kept beside rather than repeated on
   * every line-level hit. This is persisted with the tag cache, so the treemap can regroup
   * one cached gather by partition and UTC change day without querying the cards again.
   */
  cardData: Record<
    string,
    { namespaceId: string; partitionId: string; updatedDay: string } | undefined
  >;
  /**
   * Namespace IDs for cards with tag hits. Keep them beside the hits to avoid duplicating the
   * same ownership value for every hit.
   *
   * Lookups can be absent in older caches or page-filtered maps, so values are typed as
   * optional.
   */
  cardNamespaces: Record<string, string | undefined>;
  /**
   * Whether the card hit limit truncated the result. Counts derived from a truncated result
   * are lower bounds. This flag applies to the card query, separately from per-taskspace scan
   * limits.
   */
  truncated: boolean;
};

/**
 * Require a tag sigil that is literal within a LIKE pattern. A sigil containing `%` or `_`
 * needs escaping before it can be used in the prefilter.
 */
type NotLikeWildcard<T extends string> = T extends "%" | "_" ? never : T;
const SIGIL_PATTERN: NotLikeWildcard<typeof TAG_SIGIL> = TAG_SIGIL;

type GetCardTagHits = NeedsDB & {
  /** Optional namespace filter. Omit it to read cards across the workspace. */
  namespaceId?: string;
  /** How many hits to take before stopping, defaulting to {@link TAG_CARD_HITS_MAX}.
   *  Overridable so a test can reach the ceiling without putting a hundred thousand tags in
   *  the database, the same way `TaskspaceScanLimits` opens the file walk's. */
  hitsMax?: number;
  /** Override page size for the test. Production uses the default constant. */
  rowsPage?: number;
};

/**
 * Derive card tags from text, with one hit per tag per line. Reading the source text avoids
 * maintaining a separate tag index in every content-writing transaction.
 *
 * Read cards in pages and prefilter possible matches to bound memory use. This query serves
 * the tag index, outside board polling.
 */
export async function getCardTagHits({
  db,
  namespaceId,
  hitsMax = TAG_CARD_HITS_MAX,
  rowsPage = TAG_CARD_ROWS_PAGE,
}: GetCardTagHits): Promise<CardTagHits> {
  // Prefilter cards containing a colon. Some matches, such as `9:30`, still contain no tags
  // and are rejected by the parser.
  const holdsSigil = like(cardTable.content, `%${SIGIL_PATTERN}%`);
  const where: SQL | undefined = namespaceId
    ? and(holdsSigil, eq(partitionTable.namespaceId, namespaceId))
    : holdsSigil;

  const hits: TagHit[] = [];
  const cardNamespaces: Record<string, string> = {};
  const cardData: CardTagHits["cardData"] = {};
  let truncated = false;
  // Page by the same ID used for ordering so each query resumes after the previous page.
  let after: string | undefined;

  pages: for (;;) {
    const rows = await db
      .select({
        id: cardTable.id,
        content: cardTable.content,
        namespaceId: partitionTable.namespaceId,
        partitionId: cardTable.partitionId,
        updatedAt: cardTable.updatedAt,
      })
      .from(cardTable)
      .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id))
      .where(after === undefined ? where : and(where, gt(cardTable.id, after)))
      .orderBy(asc(cardTable.id))
      .limit(rowsPage);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      // Check the limit between cards and individual hits. One card can contain more hits
      // than the limit.
      //
      // Mark truncation only when a row or hit is skipped, so a result that exactly fills the
      // limit can still be complete.
      if (hits.length >= hitsMax) {
        truncated = true;
        break pages;
      }
      const found = scanTagLines(row.content);
      if (found.length === 0) continue;
      cardNamespaces[row.id] = row.namespaceId;
      cardData[row.id] = {
        namespaceId: row.namespaceId,
        partitionId: row.partitionId,
        updatedDay: row.updatedAt.toISOString().slice(0, 10),
      };
      for (const { tag, excerpt } of found) {
        if (hits.length >= hitsMax) {
          truncated = true;
          break pages;
        }
        hits.push({ tag, source: { kind: "card", cardId: row.id }, excerpt });
      }
    }

    // Stop after a short page. A full final page requires one empty query to establish that
    // no rows remain.
    if (rows.length < rowsPage) break;
  }

  return { hits, cardData, cardNamespaces, truncated };
}
