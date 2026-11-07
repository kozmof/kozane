import { readRows } from "../../services/warp-directory.js";
import { workspaceServiceContext } from "./service-context.js";
import type { AnyDB } from "../../db/client.js";

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
  const { namespaces, warps, cards } = await readRows(db, workspaceServiceContext(), namespaceId);
  // Use the board's geometry settings to identify nearby cards consistently.
  return buildWarpDirectory({
    namespaces,
    warps,
    cards,
    metrics: cardMetrics(getWorkspaceUiConfig()),
    excludeNamespaceId: namespaceId,
  });
}
