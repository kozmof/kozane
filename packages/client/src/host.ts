/** Deliberate host surface. New private helpers are not automatically public exports. */
export { browserPollLifecycle } from "./client/workspace-poller.js";
export type { PollLifecycle } from "./client/workspace-poller.js";
export {
  readObject,
  readString,
  readText,
  readFiniteNumber,
  readBoolean,
  readNullableString,
  readNullableFiniteNumber,
  readArray,
  readStringArray,
} from "./client/decoders/response.js";
export {
  readCard,
  readCardInventory,
  readWarp,
  readInventory,
  readScopeArea,
  readNamespaceSnapshot,
} from "./client/decoders/snapshot-reader.js";
export { parseWarpEntries } from "./client/decoders/warp-directory.js";
export {
  findStaticNode,
  staticDirectoryEntries,
  STATIC_FILE_SKIP_MESSAGES,
  isStaticFileTree,
} from "./client/static-files.js";
export type { ActivityGuard, BoardPoint, CardPositionPatch } from "./host-types.js";
