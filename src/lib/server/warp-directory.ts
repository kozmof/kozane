import type { AnyDB } from "../../db/client.js";
import { getAllProjects } from "../../db/api/project.js";
import { getAllWorkspaceWarps } from "../../db/api/warp.js";
import { getCardMarkersByProjects } from "../../db/api/card.js";
import { buildWarpDirectory, type WarpListEntry } from "../warp-list.js";

type LoadWarpDirectory = { db: AnyDB; projectId: string };

/**
 * The warp palette's rows for every project except the one being viewed. The viewed
 * project is left out because the page derives its own rows from live state, so a warp
 * just dropped shows up without waiting for a round trip.
 *
 * Cards are fetched only for the projects that actually have warps: with no warps
 * elsewhere this costs two small queries and no card scan at all.
 */
export async function loadWarpDirectory({
  db,
  projectId,
}: LoadWarpDirectory): Promise<WarpListEntry[]> {
  const [projects, warps] = await Promise.all([
    getAllProjects({ db }),
    getAllWorkspaceWarps({ db }),
  ]);
  const projectIds = [
    ...new Set(warps.map((warp) => warp.projectId).filter((id) => id !== projectId)),
  ];
  const cards = await getCardMarkersByProjects({ db, projectIds });
  return buildWarpDirectory({ projects, warps, cards, excludeProjectId: projectId });
}
