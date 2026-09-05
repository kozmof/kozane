import { addWarp, deleteWarp, getAllWarps } from "../../db/api/warp.js";
import { canvasBoundsForRoot, clampToBounds } from "../../lib/server/canvas.js";
import { resolveProjectId } from "../lib/project-selection.js";
import { resolveShortId, shortId } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

type WarpOptions = { project?: string };
type WarpAddOptions = WarpOptions & { x: number; y: number };

export async function warpList(options: WarpOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const projectId = await resolveProjectId(db, options.project);
    const warps = await getAllWarps({ db, projectId });
    if (warps.length === 0) {
      console.log("No warps found.");
      return;
    }
    const ids = warps.map(({ id }) => id);
    for (const [index, warp] of warps.entries())
      console.log(`${shortId(warp.id, ids)}  ${index + 1}  (${warp.posX}, ${warp.posY})`);
  });
}

export async function warpAdd({ project, x, y }: WarpAddOptions): Promise<void> {
  await runWorkspaceCommand(async ({ db, root }) => {
    const projectId = await resolveProjectId(db, project);
    const position = clampToBounds(x, y, canvasBoundsForRoot(root));
    const warp = await addWarp({ db, projectId, ...position });
    const ids = (await getAllWarps({ db, projectId })).map(({ id }) => id);
    console.log("Warp added.");
    console.log(`  id      : ${shortId(warp.id, ids)}`);
    console.log(`  position: (${warp.posX}, ${warp.posY})`);
  });
}

export async function warpDelete(requestedId: string, options: WarpOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db }) => {
    const projectId = await resolveProjectId(db, options.project);
    const warps = await getAllWarps({ db, projectId });
    const ids = warps.map(({ id }) => id);
    const warpId = resolveShortId(requestedId, ids, "Warp");
    await deleteWarp({ db, projectId, warpId });
    console.log("Warp deleted.");
    console.log(`  id: ${shortId(warpId, ids)}`);
  });
}
