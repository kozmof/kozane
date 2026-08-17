import type { CardPositionPatch } from "./project-page.js";
import type { Warp } from "$lib/types.js";
import type { WarpListEntry } from "$lib/warp-list.js";

function jsonRequest(
  fetcher: typeof fetch,
  url: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return fetcher(url, {
    method,
    ...(body !== undefined && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

export function patchCardPositions(
  fetcher: typeof fetch,
  projectId: string,
  positions: CardPositionPatch[],
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards`, "PATCH", { positions });
}

export function createCard(
  fetcher: typeof fetch,
  projectId: string,
  card: {
    bundleId: string;
    content: string;
    posX: number;
    posY: number;
    zIndex?: number;
    scopeId?: string;
    layerId?: string;
  },
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards`, "POST", card);
}

/**
 * The message a failed request explains itself with. SvelteKit's `error()` answers with
 * `{ message }`, and some of those are worth showing verbatim — "the layers changed
 * elsewhere, reload" tells the user what to do in a way a generic banner cannot.
 */
export async function failureMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

export function updateCard(
  fetcher: typeof fetch,
  projectId: string,
  cardId: string,
  card: {
    content?: string;
    bundleId?: string;
    layerId?: string;
    zIndex?: number;
    /** Null drops the card's own width, putting it back under `ui.defaultCardWidth`. */
    width?: number | null;
  },
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards/${cardId}`, "PATCH", card);
}

export function deleteCard(
  fetcher: typeof fetch,
  projectId: string,
  cardId: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards/${cardId}`, "DELETE");
}

/**
 * Replaces one card with a card per segment of its text. The split pattern is the
 * server's, so nothing about it travels in the request.
 */
export function squashCard(
  fetcher: typeof fetch,
  projectId: string,
  cardId: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards/squash`, "POST", { cardId });
}

export function deleteCards(
  fetcher: typeof fetch,
  projectId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards`, "DELETE", { cardIds });
}

export function glueCards(
  fetcher: typeof fetch,
  projectId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/glues`, "POST", { cardIds });
}

export function unglueCards(
  fetcher: typeof fetch,
  projectId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/glues`, "DELETE", { cardIds });
}

export function createBundle(
  fetcher: typeof fetch,
  projectId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/bundles`, "POST", { name });
}

export function deleteBundle(
  fetcher: typeof fetch,
  projectId: string,
  bundleId: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/bundles/${bundleId}`, "DELETE");
}

export function createLayer(
  fetcher: typeof fetch,
  projectId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/layers`, "POST", { name });
}

export function deleteLayer(
  fetcher: typeof fetch,
  projectId: string,
  layerId: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/layers/${layerId}`, "DELETE");
}

export function renameLayer(
  fetcher: typeof fetch,
  projectId: string,
  layerId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/layers/${layerId}`, "PATCH", { name });
}

/** `layerIds` is the project's full layer ordering, bottom to top. */
export function reorderLayers(
  fetcher: typeof fetch,
  projectId: string,
  layerIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/layers`, "PATCH", { layerIds });
}

/** `posX`/`posY` are the world coordinates of the view centre to come back to. */
export function createWarp(
  fetcher: typeof fetch,
  projectId: string,
  position: { posX: number; posY: number },
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/warps`, "POST", position);
}

/**
 * The row a warp POST answers with, or null when the body is not one. Unlike the other
 * mutations, which read a single field out of their response, a created warp is kept whole
 * and drawn on the board — so an unexpected body would put a marker at `undefined`.
 */
export function parseWarp(value: unknown): Warp | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, projectId, posX, posY } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof projectId !== "string") return null;
  if (!Number.isFinite(posX) || !Number.isFinite(posY)) return null;
  return { id, projectId, posX: posX as number, posY: posY as number };
}

export function deleteWarp(
  fetcher: typeof fetch,
  projectId: string,
  warpId: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/warps/${warpId}`, "DELETE");
}

/** The other projects' warps, as the palette lists them. */
export function fetchWarpDirectory(fetcher: typeof fetch, projectId: string): Promise<Response> {
  return fetcher(`/${projectId}/api/warp-directory`);
}

/**
 * The rows the warp directory answers with, or null when the body is not a list of them.
 * Checked for the same reason {@link parseWarp} is, and more so: a palette row is rendered
 * whole and then scrolled to, so an unexpected body would list rows reading `undefined`
 * and send the view to `NaN`. All or nothing — a list half of which cannot be trusted is
 * not one to replace a working list with.
 */
export function parseWarpEntries(value: unknown): WarpListEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: WarpListEntry[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) return null;
    const { id, projectId, projectName, label, posX, posY, hint, isCurrent } = row as Record<
      string,
      unknown
    >;
    if (typeof id !== "string" || typeof projectId !== "string") return null;
    if (typeof projectName !== "string" || typeof isCurrent !== "boolean") return null;
    if (!Number.isFinite(label) || !Number.isFinite(posX) || !Number.isFinite(posY)) return null;
    if (hint !== null && typeof hint !== "string") return null;
    entries.push({
      id,
      projectId,
      projectName,
      label: label as number,
      posX: posX as number,
      posY: posY as number,
      hint,
      isCurrent,
    });
  }
  return entries;
}

export function createScope(
  fetcher: typeof fetch,
  projectId: string,
  name: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/scopes`, "POST", { name });
}

export function deleteScope(
  fetcher: typeof fetch,
  projectId: string,
  scopeId: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/scopes/${scopeId}`, "DELETE");
}

export function addCardsToScope(
  fetcher: typeof fetch,
  projectId: string,
  scopeId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/scopes/${scopeId}/members`, "POST", { cardIds });
}

export function removeCardsFromScope(
  fetcher: typeof fetch,
  projectId: string,
  scopeId: string,
  cardIds: string[],
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/scopes/${scopeId}/members`, "DELETE", { cardIds });
}

export function batchReassignBundle(
  fetcher: typeof fetch,
  projectId: string,
  cardIds: string[],
  bundleId: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards/bundle`, "PATCH", { cardIds, bundleId });
}

export function batchReassignLayer(
  fetcher: typeof fetch,
  projectId: string,
  cardIds: string[],
  layerId: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards/layer`, "PATCH", { cardIds, layerId });
}

export function moveCardsToProject(
  fetcher: typeof fetch,
  projectId: string,
  cardIds: string[],
  targetProjectId: string,
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards/move`, "POST", { cardIds, targetProjectId });
}

export function createTaskspace(
  fetcher: typeof fetch,
  projectId: string,
  taskspace: { name: string; scopeId: string },
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/taskspaces`, "POST", taskspace);
}
