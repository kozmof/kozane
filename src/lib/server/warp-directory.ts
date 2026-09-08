import type { AnyDB } from "../../db/client.js";
import { getAllNamespaces } from "../../db/api/namespace.js";
import { getAllWorkspaceWarps } from "../../db/api/warp.js";
import { getCardMarkersByNamespaces } from "../../db/api/card.js";
import { buildWarpDirectory, cardMetrics, type WarpListEntry } from "../warp-list.js";
import { getWorkspaceUiConfig } from "../../db/internal/config.js";

type LoadWarpDirectory = { db: AnyDB; namespaceId: string };

/**
 * The warp palette's rows for every namespace except the one being viewed. The viewed
 * namespace is left out because the page derives its own rows from live state, so a warp
 * just dropped shows up without waiting for a round trip.
 *
 * Cards are fetched only for the namespaces that actually have warps: with no warps
 * elsewhere this costs two small queries and no card scan at all.
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
