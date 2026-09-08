import { addWarp, deleteWarp, getAllWarps } from "../../db/api/warp.js";
import { canvasBoundsForRoot, clampToBounds } from "../../lib/server/canvas.js";
import { resolveNamespaceId } from "../lib/namespace-selection.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

type WarpOptions = { namespace?: string };
type WarpAddOptions = WarpOptions & { x: number; y: number };

export async function warpList(options: WarpOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const warps = await getAllWarps({ db, namespaceId });
    if (warps.length === 0) {
      console.log("No warps found.");
      return;
    }
    const ids = warps.map(({ id }) => id);
    for (const [index, warp] of warps.entries())
      console.log(`${shortId(warp.id, ids)}  ${index + 1}  (${warp.posX}, ${warp.posY})`);
  });
}

export async function warpAdd({ namespace, x, y }: WarpAddOptions): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const namespaceId = await resolveNamespaceId(db, namespace);
    const position = clampToBounds(x, y, canvasBoundsForRoot(root));
    const warp = await addWarp({ db, namespaceId, ...position });
    const ids = (await getAllWarps({ db, namespaceId })).map(({ id }) => id);
    console.log("Warp added.");
    console.log(`  id      : ${shortId(warp.id, ids)}`);
    console.log(`  position: (${warp.posX}, ${warp.posY})`);
  });
}

export async function warpDelete(requestedId: string, options: WarpOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    const warps = await getAllWarps({ db, namespaceId });
    const ids = warps.map(({ id }) => id);
    const warpId = resolveShortId(requestedId, ids, "Warp");
    await deleteWarp({ db, namespaceId, warpId });
    console.log("Warp deleted.");
    console.log(`  id: ${shortId(warpId, ids)}`);
  });
}
