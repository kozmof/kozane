/** Deliberate host surface. New private helpers are not automatically public exports. */
export { browserPollLifecycle } from "./backend/workspace-poller.js";
export type { PollLifecycle } from "./backend/workspace-poller.js";
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
} from "./backend/decoders/response.js";
export {
  readCard,
  readCardInventory,
  readWarp,
  readInventory,
  readScopeArea,
  readNamespaceSnapshot,
} from "./backend/decoders/snapshot-reader.js";
export { parseWarpEntries } from "./backend/decoders/warp-directory.js";
export {
  findStaticNode,
  staticDirectoryEntries,
  STATIC_FILE_SKIP_MESSAGES,
  isStaticFileTree,
} from "./backend/static-files.js";
export type { ActivityGuard, BoardPoint, CardPositionPatch } from "./host-types.js";
