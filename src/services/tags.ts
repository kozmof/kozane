import { getAllPartitions } from "../db/api/partition.js";
import { getCardPartitionNames } from "../db/api/card.js";
import { applyPalette } from "../lib/palette.js";
import type { AnyDB } from "../db/database.js";
import type { ServiceContext } from "./context.js";
import { getCardTagHits } from "../db/api/tag.js";
export function get(db: AnyDB, _context: ServiceContext, namespaceId?: string) {
  return getCardTagHits({ db, namespaceId });
}

async function partitionsForNamespaces(
  db: AnyDB,
  namespaceIds: string[],
): Promise<Record<string, { name: string; dot: string }>> {
  // Load independent namespace palettes concurrently.
  const palettes = await Promise.all(
    namespaceIds.map(async (namespaceId) =>
      applyPalette(await getAllPartitions({ db, namespaceId })),
    ),
  );

  const byPartition: Record<string, { name: string; dot: string }> = {};
  for (const partitions of palettes) {
    for (const partition of partitions)
      byPartition[partition.id] = { name: partition.name, dot: partition.dot };
  }
  return byPartition;
}

export async function displayMetadata(
  db: AnyDB,
  _context: ServiceContext,
  cardIds: string[],
  namespaceIds: string[],
) {
  const [cardPartitions, partitions] = await Promise.all([
    getCardPartitionNames({ db, cardIds }),
    partitionsForNamespaces(db, namespaceIds),
  ]);
  return { cardPartitions, partitions };
}
