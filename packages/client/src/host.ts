/** Host adapters for lifecycle, wire decoding and embedded static files. */
export { browserPollLifecycle } from "./backend/workspace-poller.js";
export * from "./backend/decoders/response.js";
export * from "./backend/decoders/snapshot-reader.js";
export { parseWarpEntries } from "./backend/decoders/warp-directory.js";
export * from "./backend/static-files.js";
export interface ActivityGuard {
  readonly idle: boolean;
  readonly version: number;
  unchangedSince(version: number): boolean;
}
export type { CardPositionPatch } from "./board/lib/namespace-page.js";
export type { BoardPoint } from "./board/lib/canvas-viewport.js";
