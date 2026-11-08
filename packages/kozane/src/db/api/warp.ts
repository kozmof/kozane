import { records } from "@kozane/core/database";
export const getAllWarps: typeof records.warp.getAllWarps = records.warp.getAllWarps;
export const getAllWorkspaceWarps: typeof records.warp.getAllWorkspaceWarps =
  records.warp.getAllWorkspaceWarps;
export const addWarp: typeof records.warp.addWarp = records.warp.addWarp;
export const moveWarp: typeof records.warp.moveWarp = records.warp.moveWarp;
export const deleteWarp: typeof records.warp.deleteWarp = records.warp.deleteWarp;
