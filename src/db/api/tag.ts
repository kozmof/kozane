import { and, asc, eq, gt, like, type SQL } from "drizzle-orm";
import { bundleTable, cardTable } from "../schema.js";
import type { NeedsDB } from "./types.js";
import type { TagHit } from "../../lib/types.js";
import { scanTagLines } from "../../lib/tag.js";
import { TAG_CARD_HITS_MAX, TAG_CARD_ROWS_PAGE, TAG_SIGIL } from "../../lib/constants.js";

export type CardTagHits = {
  hits: TagHit[];
  /**
   * The map-facing dimensions of each tagged card, kept beside rather than repeated on
   * every line-level hit. This is persisted with the tag cache, so the treemap can regroup
   * one cached gather by bundle and UTC change day without querying the cards again.
   */
  cardData: Record<string, { projectId: string; bundleId: string; updatedDay: string } | undefined>;
  /**
   * Which project each card named above belongs to.
   *
   * Beside the hits rather than on them, per the note on `TagSource`: a card's project is
   * `bundle.project_id`, so putting it on every hit would be a second copy of a column the
   * card already has. It is returned at all because the index gathers across projects, and
   * a hit then has to be able to say which board it came from — the join is already made
   * here, so making it again in the caller would be a second query for a column in hand.
   *
   * The value is optional, and saying so is the point. Every card carrying a hit has an
   * entry — the loop below writes one before it writes the hit — but `Record<string, string>`
   * promises that a lookup *cannot* miss, and both readers of this already know it can: one
   * arrives through a cache file that may have been written by another build, and the page's
   * copy is narrowed to the cards actually being shown. Each had a hand-written
   * `string | undefined` annotation to work around the type; the type now says it.
   */
  cardProjects: Record<string, string | undefined>;
  /**
   * Whether {@link TAG_CARD_HITS_MAX} was reached, so `hits` is a prefix of what the cards
   * hold rather than all of it.
   *
   * Reported for the reason the file walk reports its ceilings: a list that has been cut and
   * does not say so cannot be told from a complete one, and every count taken from it — the
   * tree beside the panel, the totals under it — then reads as exact when it is a floor.
   *
   * A plain boolean rather than a member of `TagScanTruncation`, which enumerates the limits
   * a *taskspace walk* stops at and is reported per taskspace. There is one card query per
   * gather and one ceiling for it to stop at, so a taskspace-shaped record would have no
   * taskspace to name and no second reason to distinguish.
   */
  truncated: boolean;
};

/**
 * The sigil, checked to be safe inside a `LIKE` pattern — which is where the prefilter below
 * puts it, and where `%` and `_` are wildcards rather than characters.
 *
 * A type rather than a runtime guard, so the failure is a build that does not compile rather
 * than a query that quietly stops narrowing. `TAG_SIGIL` is presented in `lib/constants.ts`
 * as *the* character the grammar opens with; a sigil of `_` would turn the prefilter into
 * "every card holding at least one character" and every test would still pass, because a
 * prefilter that is too generous is invisible from the outside — it costs a scan, not an
 * answer. Anything else needs an `ESCAPE` clause here before the constant changes.
 */
type NotLikeWildcard<T extends string> = T extends "%" | "_" ? never : T;
const SIGIL_PATTERN: NotLikeWildcard<typeof TAG_SIGIL> = TAG_SIGIL;

type GetCardTagHits = NeedsDB & {
  /** Narrows to one project. Omitted, every card in the workspace is read — which is what
   *  the tag index does when no project is selected. */
  projectId?: string;
  /** How many hits to take before stopping, defaulting to {@link TAG_CARD_HITS_MAX}.
   *  Overridable so a test can reach the ceiling without putting a hundred thousand tags in
   *  the database, the same way `TaskspaceScanLimits` opens the file walk's. */
  hitsMax?: number;
  /** How many rows one page of the read brings back, defaulting to
   *  {@link TAG_CARD_ROWS_PAGE}. Overridable for the same reason `hitsMax` is: a test that
   *  has to cross a page boundary should not need a thousand cards to do it. */
  rowsPage?: number;
};

/**
 * Every tag written on a card, one hit per tag per line.
 *
 * There is no `tag` table, and deliberately. A tag is part of a card's text, so the text is
 * the only thing that can be the source of truth about it: a materialized index would have
 * to be rewritten inside every transaction that writes `card.content` — `addCard`,
 * `addCards`, `updateCard`, the squash endpoint, `kozane card squash`, `db import` — and the
 * first writer to forget leaves an index that disagrees with the board and nothing that
 * would say so. Derived on read, a tag exists exactly as long as the text holding it does.
 *
 * What that costs is one scan of the cards in question. It is bounded by `contentMax` per
 * row and narrowed below to the rows that could possibly match, and it answers a page a user
 * has navigated to rather than the once-a-second board poll.
 *
 * Read a page at a time, so what the gather *holds* is bounded as well as what it keeps. See
 * {@link TAG_CARD_ROWS_PAGE}: a single statement for the whole workspace brought back the
 * text of every tagged card at once, which is the one read on this path that answered to no
 * ceiling at all.
 */
export async function getCardTagHits({
  db,
  projectId,
  hitsMax = TAG_CARD_HITS_MAX,
  rowsPage = TAG_CARD_ROWS_PAGE,
}: GetCardTagHits): Promise<CardTagHits> {
  // A card with no apostrophe cannot hold a tag, so SQLite drops it before any of it crosses
  // into JavaScript to be parsed. Necessary rather than sufficient — `don't` comes back and
  // finds nothing — which is the right way round for a prefilter.
  const holdsSigil = like(cardTable.content, `%${SIGIL_PATTERN}%`);
  const where: SQL | undefined = projectId
    ? and(holdsSigil, eq(bundleTable.projectId, projectId))
    : holdsSigil;

  const hits: TagHit[] = [];
  const cardProjects: Record<string, string> = {};
  const cardData: CardTagHits["cardData"] = {};
  let truncated = false;
  // Where the last page ended. Ordered by the same column it pages on, which is what makes
  // "after this one" mean the next row rather than an arbitrary one — and what makes a hit
  // list built over several statements the same list one statement would have built.
  let after: string | undefined;

  pages: for (;;) {
    const rows = await db
      .select({
        id: cardTable.id,
        content: cardTable.content,
        projectId: bundleTable.projectId,
        bundleId: cardTable.bundleId,
        updatedAt: cardTable.updatedAt,
      })
      .from(cardTable)
      .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
      .where(after === undefined ? where : and(where, gt(cardTable.id, after)))
      .orderBy(asc(cardTable.id))
      .limit(rowsPage);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      // Checked between cards and again between the hits of one, so the ceiling is exact
      // rather than per card — the same reason the file walk checks in both places. A card is
      // bounded in length by `ui.contentMax`, which a workspace may raise, so one card can
      // hold more tags on its own than this carries.
      //
      // Truncation is decided by a row that was read and not used, which is why this stays
      // inside the page loop rather than becoming a "was there another page?" question: a
      // gather whose last hit exactly fills the ceiling has read every card there was, and
      // saying it was cut short would send the reader looking for tags that are all here.
      if (hits.length >= hitsMax) {
        truncated = true;
        break pages;
      }
      const found = scanTagLines(row.content);
      if (found.length === 0) continue;
      cardProjects[row.id] = row.projectId;
      cardData[row.id] = {
        projectId: row.projectId,
        bundleId: row.bundleId,
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

    // A short page is the last one. A full one may or may not be, so the next statement is
    // what settles it — and comes back empty, which is one extra read of no rows against
    // holding the whole workspace to find out.
    if (rows.length < rowsPage) break;
  }

  return { hits, cardData, cardProjects, truncated };
}
