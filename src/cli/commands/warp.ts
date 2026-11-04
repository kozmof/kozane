import * as service from "../../services/warps.js";
import { createServiceContext } from "../../services/context.js";
import { getUiConfigForRoot } from "../../db/internal/config.js";
import { composeWrite } from "../../db/database.js";
import { getAllWarps } from "../../db/api/warp.js";
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
    const context = createServiceContext(getUiConfigForRoot(root));
    const { namespaceId, warp } = await composeWrite(db, async (tx) => {
      const namespaceId = await resolveNamespaceId(tx, namespace);
      const warp = await service.createInTx(tx, context, namespaceId, { posX: x, posY: y });
      return { namespaceId, warp };
    });
    const ids = (await getAllWarps({ db, namespaceId })).map(({ id }) => id);
    console.log("Warp added.");
    console.log(`  id      : ${shortId(warp.id, ids)}`);
    console.log(`  position: (${warp.posX}, ${warp.posY})`);
  });
}

export async function warpDelete(requestedId: string, options: WarpOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const context = createServiceContext(getUiConfigForRoot(root));
    const { warpId, ids } = await composeWrite(db, async (tx) => {
      const namespaceId = await resolveNamespaceId(tx, options.namespace);
      const warps = await getAllWarps({ db: tx, namespaceId });
      const ids = warps.map((warp) => warp.id);
      const warpId = resolveShortId(requestedId, ids, "Warp");
      await service.removeInTx(tx, context, namespaceId, warpId);
      return { warpId, ids };
    });
    console.log("Warp deleted.");
    console.log(`  id: ${shortId(warpId, ids)}`);
  });
}
