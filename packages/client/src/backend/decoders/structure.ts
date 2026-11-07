import type {
  LayerCreateResult,
  LayerRemoveResult,
  NamespaceCreateResult,
  PartitionCreateResult,
  PartitionRemoveResult,
} from "../resources.js";
import { readNamespaceMetadata } from "./namespaces.js";
import { readStackingRows } from "./collections.js";
import { readBoolean, readFiniteNumber, readString } from "./response.js";

export function readMutationOk(value: unknown): { ok: true } | null {
  return readBoolean(value, "ok") === true ? { ok: true } : null;
}
export function readCreatedId(value: unknown): PartitionCreateResult | null {
  const id = readString(value, "id");
  return id ? { id } : null;
}
export function readNamespaceCreated(value: unknown): NamespaceCreateResult | null {
  const result = readNamespaceMetadata(value);
  return result?.isDefault === false ? result : null;
}
export function readLayerCreated(value: unknown): LayerCreateResult | null {
  const id = readString(value, "id");
  const name = readString(value, "name");
  const position = readFiniteNumber(value, "position");
  return id && name && position !== undefined && readBoolean(value, "isDefault") === false
    ? { id, name, position, isDefault: false }
    : null;
}
export function readLayerRemoved(value: unknown): LayerRemoveResult | null {
  const defaultLayerId = readString(value, "defaultLayerId");
  const stacking = readStackingRows(value);
  if (!readMutationOk(value) || !defaultLayerId || !stacking) return null;
  return { ok: true, defaultLayerId, stacking };
}
export function readPartitionRemoved(value: unknown): PartitionRemoveResult | null {
  const defaultPartitionId = readString(value, "defaultPartitionId");
  return readMutationOk(value) && defaultPartitionId ? { ok: true, defaultPartitionId } : null;
}
