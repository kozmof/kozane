import { and, eq, like, type SQL } from "drizzle-orm";
import { bundleTable, cardTable } from "../schema.js";
import type { NeedsDB } from "./types.js";
import type { TagHit } from "../../lib/types.js";
import { scanTagLines } from "../../lib/tag.js";
import { TAG_SIGIL } from "../../lib/constants.js";

export type CardTagHits = {
  hits: TagHit[];
  /**
   * Which project each card named above belongs to.
   *
   * Beside the hits rather than on them, per the note on `TagSource`: a card's project is
   * `bundle.project_id`, so putting it on every hit would be a second copy of a column the
   * card already has. It is returned at all because the index gathers across projects, and
   * a hit then has to be able to say which board it came from — the join is already made
   * here, so making it again in the caller would be a second query for a column in hand.
   */
  cardProjects: Record<string, string>;
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
 */
export async function getCardTagHits({ db, projectId }: GetCardTagHits): Promise<CardTagHits> {
  // A card with no apostrophe cannot hold a tag, so SQLite drops it before any of it crosses
  // into JavaScript to be parsed. Necessary rather than sufficient — `don't` comes back and
  // finds nothing — which is the right way round for a prefilter.
  const holdsSigil = like(cardTable.content, `%${SIGIL_PATTERN}%`);
  const where: SQL | undefined = projectId
    ? and(holdsSigil, eq(bundleTable.projectId, projectId))
    : holdsSigil;

  const rows = await db
    .select({ id: cardTable.id, content: cardTable.content, projectId: bundleTable.projectId })
    .from(cardTable)
    .innerJoin(bundleTable, eq(cardTable.bundleId, bundleTable.id))
    .where(where);

  const hits: TagHit[] = [];
  const cardProjects: Record<string, string> = {};
  for (const row of rows) {
    const found = scanTagLines(row.content);
    if (found.length === 0) continue;
    cardProjects[row.id] = row.projectId;
    for (const { tag, excerpt } of found) {
      hits.push({ tag, source: { kind: "card", cardId: row.id }, excerpt });
    }
  }

  return { hits, cardProjects };
}
