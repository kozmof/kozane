import { eq, inArray } from "drizzle-orm";
import { partitionTable, cardTable, scopeTable } from "../../db/schema.js";
import { getDefaultPartition } from "../../db/api/partition.js";
import { getAllLayers } from "../../db/api/layer.js";
import { chunked, STATEMENT_PARAMS_MAX } from "../../lib/constants.js";
import type { DB } from "../../db/tx.js";
import { findById, resolveShortId } from "./short-id.js";
import { resolveLayerRef } from "./layer-ref.js";

/**
 * Turning what someone typed into the row it names — short ids, defaults, and the reads
 * behind them.
 *
 * Lifted out of `commands/card.ts`, where it sat above thirteen commands as a hundred and
 * fifty lines of plumbing they all reach for. Two things follow from moving it, and the
 * second is the reason:
 *
 * - A command module holds commands. What is left there is what each subcommand *does*,
 *   rather than that plus the shared machinery it does it with.
 * - It becomes measurable. `src/cli/commands/**` is excluded from coverage because every
 *   one of those is exercised by spawning `kozane` as a subprocess, which v8 cannot
 *   instrument from this process — so this code, which is ordinary async functions over a
 *   database and has nothing to do with argv or process exit, was excluded along with it.
 *   Under `cli/lib` it is measured and can be driven directly by a test.
 *
 * Nothing here prints or exits. Errors are thrown for `runWorkspaceCommand` to turn into a
 * message and a status, which is what every caller already does with them.
 */

/**
 * A position given either outright or relative to where the card already is —
 * `current+100`, as `kozane card move` takes it.
 */
export function movedCoordinate(value: number | string, current: number): number {
  if (typeof value === "number") return value;
  const match = value.match(/^current([+-]\d+)$/);
  if (!match) throw new Error(`Invalid card position: ${value}`);
  return current + Number(match[1]);
}

/**
 * Resolve card references together and retain the namespace needed by the guarded glue APIs.
 *
 * Workspace-wide, and it has to be: an abbreviated id is unambiguous or it is not, and the
 * set it is unambiguous *in* is every card there is — `kozane card namespace` moves cards
 * between namespaces, so narrowing this to one would make a prefix resolve here that
 * `shortId` had refused to print. What each id is printed back as depends on the same set.
 *
 * What it does not read is every card's *text*. This selected `content` — and `width`,
 * `pos_x`, `pos_y` — for every card in the workspace in order to answer a question about
 * ids, so `kozane card delete 3f9a2c1` read every word anyone had written. The two columns
 * resolution needs are here; {@link loadCards} fetches the rest for the handful of cards a
 * command actually acts on.
 */
export async function resolveCardGroup(db: DB, requestedIds: string[]) {
  const index = await db
    .select({ id: cardTable.id, namespaceId: partitionTable.namespaceId })
    .from(cardTable)
    .innerJoin(partitionTable, eq(cardTable.partitionId, partitionTable.id));
  const allIds = index.map(({ id }) => id);
  const cardIds = requestedIds.map((id) => resolveShortId(id, allIds, "Card"));
  const namespaceId = findById(index, cardIds[0], "Card").namespaceId;
  return { index, allIds, cardIds, namespaceId };
}

/** What a command that positions or re-lays-out cards needs of each one. */
export type LoadedCard = {
  id: string;
  content: string;
  width: number | null;
  posX: number;
  posY: number;
};

/**
 * The full rows behind a resolved set of ids.
 *
 * Chunked, because the set is not always what someone typed: `card glue --add` expands a
 * selection to whole glue groups, and a group has no ceiling short of the namespace. One
 * bound parameter per id puts a large enough group past {@link STATEMENT_PARAMS_MAX}, which
 * SQLite refuses after building the statement rather than before.
 */
export async function loadCards(db: DB, cardIds: string[]): Promise<LoadedCard[]> {
  const rows: LoadedCard[] = [];
  for (const batch of chunked(cardIds, { size: STATEMENT_PARAMS_MAX })) {
    const found = await db
      .select({
        id: cardTable.id,
        content: cardTable.content,
        width: cardTable.width,
        posX: cardTable.posX,
        posY: cardTable.posY,
      })
      .from(cardTable)
      .where(inArray(cardTable.id, batch));
    rows.push(...found);
  }
  return rows;
}

export async function resolvePartitionId(
  db: DB,
  namespaceId: string,
  requestedId?: string,
): Promise<string> {
  if (requestedId) {
    const partitions = await db
      .select({ id: partitionTable.id })
      .from(partitionTable)
      .where(eq(partitionTable.namespaceId, namespaceId));
    return resolveShortId(
      requestedId,
      partitions.map(({ id }) => id),
      "Partition",
    );
  }
  const partition = await getDefaultPartition({ db, namespaceId });
  if (!partition) throw new Error(`Namespace has no default partition: ${namespaceId}`);
  return partition.id;
}

/** The requested layer, or the namespace's default one when nothing was asked for. */
export async function resolveLayerId(
  db: DB,
  namespaceId: string,
  requested?: string,
): Promise<string> {
  const layers = await getAllLayers({ db, namespaceId });
  if (!requested) {
    const defaultLayer = layers.find(({ isDefault }) => isDefault);
    if (!defaultLayer) throw new Error(`Namespace has no default layer: ${namespaceId}`);
    return defaultLayer.id;
  }
  return resolveLayerRef(layers, requested);
}

export async function resolveScopeId(db: DB, requestedId: string): Promise<string> {
  const scopes = await db.select({ id: scopeTable.id }).from(scopeTable);
  return resolveShortId(
    requestedId,
    scopes.map(({ id }) => id),
    "Scope",
  );
}
