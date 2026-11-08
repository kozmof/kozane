/** Structural host contracts, independent of board implementation modules. */
export interface ActivityGuard {
  readonly idle: boolean;
  readonly version: number;
  unchangedSince(version: number): boolean;
}
export interface BoardPoint {
  posX: number;
  posY: number;
}
export type { CardPositionUpdate as CardPositionPatch } from "@kozane/core";
