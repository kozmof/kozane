import type {
  Partition,
  CardWithGlue,
  GlueRel,
  Layer,
  NamespaceDataSnapshot,
  Scope,
  ScopeRel,
  ScopeArea,
  TaskspaceSummary,
  Warp,
} from "$lib/types.js";
import { PATH_KINDS, type PathKind } from "$lib/constants.js";
import {
  readArray,
  readBoolean,
  readFiniteNumber,
  readNullableFiniteNumber,
  readNullableString,
  readString,
  readText,
} from "./response.js";

/**
 * Validate the full snapshot and every list element before applying it. Reject invalid
 * results as a whole so the board keeps its current state and can retry on the next poll.
 */

/** Reads every element of `key`'s array with `readOne`, or nothing if any element fails. */
function readRows<T>(
  source: unknown,
  key: string,
  readOne: (row: unknown) => T | undefined,
): T[] | undefined {
  const rows = readArray(source, key);
  if (!rows) return undefined;
  const parsed: T[] = [];
  for (const row of rows) {
    const one = readOne(row);
    if (one === undefined) return undefined;
    parsed.push(one);
  }
  return parsed;
}

/**
 * Validate a card from any API response. Share this reader between snapshots, card creation,
 * and squash results. Mutation parsers adapt its failure value to their null convention.
 */
export function readCard(row: unknown): CardWithGlue | undefined {
  const id = readString(row, "id");
  const partitionId = readString(row, "partitionId");
  const layerId = readString(row, "layerId");
  // Empty content is an ordinary card, not a malformed one.
  const content = readText(row, "content");
  const posX = readFiniteNumber(row, "posX");
  const posY = readFiniteNumber(row, "posY");
  const zIndex = readFiniteNumber(row, "zIndex");
  if (
    id === undefined ||
    partitionId === undefined ||
    layerId === undefined ||
    content === undefined ||
    posX === undefined ||
    posY === undefined ||
    zIndex === undefined
  ) {
    return undefined;
  }
  // Null is valid for taskspace, glue-group, and width fields. Compare against `undefined`,
  // which indicates invalid input, rather than coalescing null away.
  const taskspaceId = readNullableString(row, "taskspaceId");
  const glueId = readNullableString(row, "glueId");
  const width = readNullableFiniteNumber(row, "width");
  if (taskspaceId === undefined || glueId === undefined || width === undefined) return undefined;

  return { id, partitionId, layerId, content, posX, posY, zIndex, taskspaceId, glueId, width };
}

function readPartition(row: unknown): Partition | undefined {
  const id = readString(row, "id");
  const namespaceId = readString(row, "namespaceId");
  const name = readText(row, "name");
  const isDefault = readBoolean(row, "isDefault");
  if (
    id === undefined ||
    namespaceId === undefined ||
    name === undefined ||
    isDefault === undefined
  )
    return undefined;
  return { id, namespaceId, name, isDefault };
}

function readLayer(row: unknown): Layer | undefined {
  const id = readString(row, "id");
  const namespaceId = readString(row, "namespaceId");
  const name = readText(row, "name");
  const position = readFiniteNumber(row, "position");
  const isDefault = readBoolean(row, "isDefault");
  if (
    id === undefined ||
    namespaceId === undefined ||
    name === undefined ||
    position === undefined ||
    isDefault === undefined
  ) {
    return undefined;
  }
  return { id, namespaceId, name, position, isDefault };
}

function readWarp(row: unknown): Warp | undefined {
  const id = readString(row, "id");
  const namespaceId = readString(row, "namespaceId");
  const posX = readFiniteNumber(row, "posX");
  const posY = readFiniteNumber(row, "posY");
  if (id === undefined || namespaceId === undefined || posX === undefined || posY === undefined)
    return undefined;
  return { id, namespaceId, posX, posY };
}

function readScope(row: unknown): Scope | undefined {
  const id = readString(row, "id");
  const name = readText(row, "name");
  if (id === undefined || name === undefined) return undefined;
  return { id, name };
}

function readScopeRel(row: unknown): ScopeRel | undefined {
  const scopeId = readString(row, "scopeId");
  const cardId = readString(row, "cardId");
  if (scopeId === undefined || cardId === undefined) return undefined;
  return { scopeId, cardId };
}

function readScopeArea(row: unknown): ScopeArea | undefined {
  const id = readString(row, "id");
  const scopeId = readString(row, "scopeId");
  const namespaceId = readString(row, "namespaceId");
  const posX = readFiniteNumber(row, "posX");
  const posY = readFiniteNumber(row, "posY");
  const width = readFiniteNumber(row, "width");
  const height = readFiniteNumber(row, "height");
  if (
    id === undefined ||
    scopeId === undefined ||
    namespaceId === undefined ||
    posX === undefined ||
    posY === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined;
  }
  return { id, scopeId, namespaceId, posX, posY, width, height };
}

function readGlueRel(row: unknown): GlueRel | undefined {
  const glueId = readString(row, "glueId");
  const cardId = readString(row, "cardId");
  if (glueId === undefined || cardId === undefined) return undefined;
  return { glueId, cardId };
}

function readPathKind(row: unknown): PathKind | undefined {
  const value = readString(row, "pathKind");
  return PATH_KINDS.find((kind) => kind === value);
}

function readTaskspace(row: unknown): TaskspaceSummary | undefined {
  const id = readString(row, "id");
  const name = readText(row, "name");
  const pathKind = readPathKind(row);
  // Both fields are nullable. A taskspace may have no scope, and exports omit paths unless
  // `includeTaskspacePaths` is enabled.
  const scopeId = readNullableString(row, "scopeId");
  const path = readNullableString(row, "path");
  if (
    id === undefined ||
    name === undefined ||
    pathKind === undefined ||
    scopeId === undefined ||
    path === undefined
  ) {
    return undefined;
  }
  return { id, name, scopeId, path, pathKind };
}

/**
 * A snapshot response as {@link NamespaceDataSnapshot}, or `undefined` if it is not one.
 *
 * The narrowing is real, so what comes out needs no casts and `refreshFromData` becomes
 * total over its input rather than trusting its caller.
 */
export function readNamespaceSnapshot(source: unknown): NamespaceDataSnapshot | undefined {
  const namespaceId = readString((source as { namespace?: unknown } | null)?.namespace, "id");
  if (namespaceId === undefined) return undefined;

  const cards = readRows(source, "cards", readCard);
  const partitions = readRows(source, "partitions", readPartition);
  const layers = readRows(source, "layers", readLayer);
  const warps = readRows(source, "warps", readWarp);
  const scopes = readRows(source, "scopes", readScope);
  const scopeRels = readRows(source, "scopeRels", readScopeRel);
  const scopeAreas = readRows(source, "scopeAreas", readScopeArea);
  const glueRels = readRows(source, "glueRels", readGlueRel);
  const taskspaces = readRows(source, "taskspaces", readTaskspace);

  if (
    !cards ||
    !partitions ||
    !layers ||
    !warps ||
    !scopes ||
    !scopeRels ||
    !scopeAreas ||
    !glueRels ||
    !taskspaces
  ) {
    return undefined;
  }

  return {
    namespace: { id: namespaceId },
    cards,
    partitions,
    layers,
    warps,
    scopes,
    scopeRels,
    scopeAreas,
    glueRels,
    taskspaces,
  };
}
