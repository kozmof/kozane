import type { AnyDB } from "../database.js";
import type { ServiceContext } from "./context.js";
import { getAllNamespaces } from "../../../../src/db/api/namespace.js";
import { getAllWorkspaceWarps } from "../../../../src/db/api/warp.js";
import { getCardMarkersByNamespaces } from "../../../../src/db/api/card.js";
export async function readRows(db: AnyDB, _context: ServiceContext, namespaceId: string) {
  const namespaces = await getAllNamespaces({ db });
  const warps = await getAllWorkspaceWarps({ db });
  const namespaceIds = [
    ...new Set(warps.map((warp) => warp.namespaceId).filter((id) => id !== namespaceId)),
  ];
  const cards = await getCardMarkersByNamespaces({ db, namespaceIds });
  return { namespaces, warps, cards };
}
