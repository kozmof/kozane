import type { CardPositionPatch } from "./project-page.js";

export function patchCardPositions(
  fetcher: typeof fetch,
  projectId: string,
  positions: CardPositionPatch[],
): Promise<Response> {
  return fetcher(`/${projectId}/api/cards`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positions }),
  });
}
