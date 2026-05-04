import type { CardPositionPatch } from "./project-page.js";

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
  card: { bundleId: string; content: string; posX: number; posY: number },
): Promise<Response> {
  return jsonRequest(fetcher, `/${projectId}/api/cards`, "POST", card);
}

export function updateCard(
  fetcher: typeof fetch,
  projectId: string,
  cardId: string,
  card: { content?: string; bundleId?: string },
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
