import type { NamespaceGetResult, NamespaceListResult } from "../resources.js";
import { readBoolean, readString } from "./response.js";

/** Decode metadata before a backend consumer can use its identity or default selection. */
export function readNamespaceMetadata(value: unknown): NamespaceGetResult | null {
  const id = readString(value, "id");
  const name = readString(value, "name");
  const isDefault = readBoolean(value, "isDefault");
  return id && name !== undefined && isDefault !== undefined ? { id, name, isDefault } : null;
}

/** Reject the whole list when metadata is malformed or identities are ambiguous. */
export function readNamespaceList(value: unknown): NamespaceListResult | null {
  if (!Array.isArray(value)) return null;
  const rows: NamespaceListResult = [];
  const ids = new Set<string>();
  for (const valueRow of value) {
    const row = readNamespaceMetadata(valueRow);
    if (!row || ids.has(row.id)) return null;
    ids.add(row.id);
    rows.push(row);
  }
  return rows;
}
