import type {
  Bundle,
  CardWithGlue,
  GlueRel,
  Layer,
  ProjectDataSnapshot,
  Scope,
  ScopeRel,
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
 * The board, read off a snapshot response rather than trusted from it.
 *
 * `response.ts` guards what a mutation answers with, and this is the same guard on the
 * one response that was still going in unchecked — the once-a-second poll, which reloads
 * the entire board. `await response.json()` resolves to `any`, so a body with `cards`
 * missing put `undefined` where the card list goes and the board rendered from it; a card
 * with no `posX` landed at `NaN` on the canvas. Neither says anything about what went
 * wrong, and both survive to the next poll, which applies the same body again.
 *
 * All or nothing, per list and overall: a snapshot describes one consistent state of the
 * database, and half of one is not a smaller version of it. An unreadable snapshot is
 * simply not applied — the board keeps what it has and the next poll tries again, which is
 * already how the poll treats a failed request.
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

function readCard(row: unknown): CardWithGlue | undefined {
  const id = readString(row, "id");
  const bundleId = readString(row, "bundleId");
  const layerId = readString(row, "layerId");
  // Empty content is an ordinary card, not a malformed one.
  const content = readText(row, "content");
  const posX = readFiniteNumber(row, "posX");
  const posY = readFiniteNumber(row, "posY");
  const zIndex = readFiniteNumber(row, "zIndex");
  if (
    id === undefined ||
    bundleId === undefined ||
    layerId === undefined ||
    content === undefined ||
    posX === undefined ||
    posY === undefined ||
    zIndex === undefined
  ) {
    return undefined;
  }
  // Nullable by design: a card with no taskspace, no glue group, and no width of its own
  // is the ordinary case, so `null` here is a value rather than a failure. `undefined`
  // from these readers means "present but the wrong type", which is why each is compared
  // against it rather than coalesced away.
  const taskspaceId = readNullableString(row, "taskspaceId");
  const glueId = readNullableString(row, "glueId");
  const width = readNullableFiniteNumber(row, "width");
  if (taskspaceId === undefined || glueId === undefined || width === undefined) return undefined;

  return { id, bundleId, layerId, content, posX, posY, zIndex, taskspaceId, glueId, width };
}

function readBundle(row: unknown): Bundle | undefined {
  const id = readString(row, "id");
  const projectId = readString(row, "projectId");
  const name = readText(row, "name");
  const isDefault = readBoolean(row, "isDefault");
  if (id === undefined || projectId === undefined || name === undefined || isDefault === undefined)
    return undefined;
  return { id, projectId, name, isDefault };
}

function readLayer(row: unknown): Layer | undefined {
  const id = readString(row, "id");
  const projectId = readString(row, "projectId");
  const name = readText(row, "name");
  const position = readFiniteNumber(row, "position");
  const isDefault = readBoolean(row, "isDefault");
  if (
    id === undefined ||
    projectId === undefined ||
    name === undefined ||
    position === undefined ||
    isDefault === undefined
  ) {
    return undefined;
  }
  return { id, projectId, name, position, isDefault };
}

function readWarp(row: unknown): Warp | undefined {
  const id = readString(row, "id");
  const projectId = readString(row, "projectId");
  const posX = readFiniteNumber(row, "posX");
  const posY = readFiniteNumber(row, "posY");
  if (id === undefined || projectId === undefined || posX === undefined || posY === undefined)
    return undefined;
  return { id, projectId, posX, posY };
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
  // Both nullable on the table: an unplaced taskspace has no scope, and a static export
  // strips the path (see `includeTaskspacePaths`).
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
 * A snapshot response as {@link ProjectDataSnapshot}, or `undefined` if it is not one.
 *
 * The narrowing is real, so what comes out needs no casts and `refreshFromData` becomes
 * total over its input rather than trusting its caller.
 */
export function readProjectSnapshot(source: unknown): ProjectDataSnapshot | undefined {
  const projectId = readString((source as { project?: unknown } | null)?.project, "id");
  if (projectId === undefined) return undefined;

  const cards = readRows(source, "cards", readCard);
  const bundles = readRows(source, "bundles", readBundle);
  const layers = readRows(source, "layers", readLayer);
  const warps = readRows(source, "warps", readWarp);
  const scopes = readRows(source, "scopes", readScope);
  const scopeRels = readRows(source, "scopeRels", readScopeRel);
  const glueRels = readRows(source, "glueRels", readGlueRel);
  const taskspaces = readRows(source, "taskspaces", readTaskspace);

  if (
    !cards ||
    !bundles ||
    !layers ||
    !warps ||
    !scopes ||
    !scopeRels ||
    !glueRels ||
    !taskspaces
  ) {
    return undefined;
  }

  return {
    project: { id: projectId },
    cards,
    bundles,
    layers,
    warps,
    scopes,
    scopeRels,
    glueRels,
    taskspaces,
  };
}
