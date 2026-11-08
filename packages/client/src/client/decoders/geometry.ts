import type { ScopeRenameResult, ScopeCreateAreaResult, WarpCreateResult } from "../resources.js";
import { readString } from "./response.js";
import { readScopeArea, readWarp } from "./snapshot-reader.js";

export function readScopeRenamed(value: unknown, scopeId: string): ScopeRenameResult | null {
  const id = readString(value, "id");
  const name = readString(value, "name");
  return id === scopeId && name ? { id, name } : null;
}
/** Bind returned geometry to the destination whose mutation was dispatched. */
export function readScopeAreaResult(
  value: unknown,
  namespaceId: string,
  scopeId: string,
  areaId?: string,
): ScopeCreateAreaResult | null {
  const area = readScopeArea(value);
  return area &&
    area.namespaceId === namespaceId &&
    area.scopeId === scopeId &&
    (areaId === undefined || area.id === areaId)
    ? area
    : null;
}
export function readWarpResult(
  value: unknown,
  namespaceId: string,
  warpId?: string,
): WarpCreateResult | null {
  const warp = readWarp(value);
  return warp && warp.namespaceId === namespaceId && (warpId === undefined || warp.id === warpId)
    ? warp
    : null;
}
