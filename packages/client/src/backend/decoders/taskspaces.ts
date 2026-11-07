import { PATH_KINDS } from "../../constants/index.js";
import type {
  TaskspaceEntry,
  TaskspaceEntryKind,
  TaskspaceListing,
  TaskspaceTruncation,
} from "../../../../../src/lib/types.js";
import type {
  TaskspaceCreated,
  TaskspaceRenamed,
  TaskspaceFileData,
  TaskspaceRemoveResult,
  TaskspaceRenameEntryResult,
} from "../taskspaces-api.js";
import {
  readArray,
  readBoolean,
  readNullableFiniteNumber,
  readNullableString,
  readString,
  readText,
} from "./response.js";

function member<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}
const entryKinds: readonly TaskspaceEntryKind[] = ["directory", "file", "symlink", "other"];
const truncations: readonly TaskspaceTruncation[] = ["entries", "depth", "nodes", "unreadable"];

export function readTaskspaceCreated(value: unknown): TaskspaceCreated | null {
  const id = readString(value, "id");
  const path = readString(value, "path");
  const pathKind = readString(value, "pathKind");
  return id && path && member(pathKind, PATH_KINDS) ? { id, path, pathKind } : null;
}
export function readTaskspaceRenamed(value: unknown): TaskspaceRenamed | null {
  const id = readString(value, "id");
  const name = readText(value, "name");
  const path = readNullableString(value, "path");
  const pathKind = readString(value, "pathKind");
  return id && name !== undefined && path !== undefined && member(pathKind, PATH_KINDS)
    ? { id, name, path, pathKind }
    : null;
}
export function readTaskspaceRemoved(value: unknown): TaskspaceRemoveResult | null {
  const ok = readBoolean(value, "ok");
  const directory = readString(value, "directory");
  return ok === true && member(directory, ["deleted", "missing", "kept"] as const)
    ? { ok, directory }
    : null;
}
export function readTaskspaceFile(value: unknown): TaskspaceFileData | null {
  const path = readString(value, "path");
  const content = readText(value, "content");
  const signature = readNullableString(value, "signature");
  return path && content !== undefined && signature !== undefined
    ? { path, content, signature }
    : null;
}
export function readTaskspaceEntryResult(value: unknown): TaskspaceRenameEntryResult | null {
  const path = readString(value, "path");
  const kind = readString(value, "kind");
  return path && member(kind, entryKinds) ? { path, kind } : null;
}
function readEntry(value: unknown): TaskspaceEntry | null {
  const name = readString(value, "name");
  const kind = readString(value, "kind");
  const modifiedAt = readNullableString(value, "modifiedAt");
  // A null size is distinct from an absent or non-finite size.
  const size = readNullableFiniteNumber(value, "size");
  return name &&
    member(kind, entryKinds) &&
    modifiedAt !== undefined &&
    size !== undefined &&
    (size === null || size >= 0)
    ? { name, kind, modifiedAt, size }
    : null;
}
export function readTaskspaceListing(value: unknown): TaskspaceListing | null {
  const path = readText(value, "path");
  const truncated = readBoolean(value, "truncated");
  const rows = readArray(value, "entries");
  if (path === undefined || truncated === undefined || !rows) return null;
  const entries: TaskspaceEntry[] = [];
  const names = new Set<string>();
  for (const valueRow of rows) {
    const row = readEntry(valueRow);
    if (!row || names.has(row.name)) return null;
    names.add(row.name);
    entries.push(row);
  }
  // Live listings omit this field. Embedded listings can retain a specific reason.
  const record = value as Record<string, unknown>;
  const reason = record.truncation;
  if (reason !== undefined && reason !== null && !member(reason, truncations)) return null;
  return { path, truncated, entries, ...(reason === undefined ? {} : { truncation: reason }) };
}
