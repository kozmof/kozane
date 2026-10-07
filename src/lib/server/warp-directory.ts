import type { AnyDB } from "../../db/client.js";
import { getAllNamespaces } from "../../db/api/namespace.js";
import { getAllWorkspaceWarps } from "../../db/api/warp.js";
import { getCardMarkersByNamespaces } from "../../db/api/card.js";
import { buildWarpDirectory, cardMetrics, type WarpListEntry } from "../warp-list.js";
import { getWorkspaceUiConfig } from "../../db/internal/config.js";

type LoadWarpDirectory = { db: AnyDB; namespaceId: string };

/**
 * Warp-palette rows for other namespaces. The current namespace derives its rows from live
 * state so new warps appear immediately. Fetch cards only for namespaces with warps.
 */
export async function loadWarpDirectory({
  db,
  namespaceId,
}: LoadWarpDirectory): Promise<WarpListEntry[]> {
  const [namespaces, warps] = await Promise.all([
    getAllNamespaces({ db }),
    getAllWorkspaceWarps({ db }),
  ]);
  const namespaceIds = [
    ...new Set(warps.map((warp) => warp.namespaceId).filter((id) => id !== namespaceId)),
  ];
  const cards = await getCardMarkersByNamespaces({ db, namespaceIds });
  // The same numbers the boards are drawn with, so "the card under this warp" means here
  // what it means on screen.
  return buildWarpDirectory({
    namespaces,
    warps,
    cards,
    metrics: cardMetrics(getWorkspaceUiConfig()),
    excludeNamespaceId: namespaceId,
  });
}
