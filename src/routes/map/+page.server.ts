import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getDBURL, getWorkspaceRoot, getWorkspaceUiConfig } from "$db/internal/config";
import { normalizeTag } from "$lib/tag";
import { loadTreemapSnapshot } from "$lib/server/treemap-snapshot";
import { mapView, validActivityDay } from "$lib/backend/views/map.js";
import { httpBackendCapabilities } from "$lib/server/backend-capabilities.js";
export type { MapPartition, MapScope, MapSpoke } from "$lib/backend/views/map.js";
import { isSsgBuild, ssgIncludesScopedFiles } from "$lib/server/ssg";

/**
 * Load the read-only workspace map, including namespace and partition sizes, scope links, and
 * card tags. Use the persisted semantic snapshot without scanning taskspace files.
 */

// Prerender one map route. Namespace filtering uses query parameters at runtime rather than
// separate prerender entries.
export const prerender = isSsgBuild();

/**
 * Include scope data in static exports only when scoped files were requested. Gate collection
 * before serialization so omitted scopes are absent from page data too.
 */
const includeScopedFiles = ssgIncludesScopedFiles();
const includeScopes = !prerender || includeScopedFiles;

function cacheLocation(): { root: string; dbUrl: string } | undefined {
  if (prerender || !getWorkspaceRoot()) return undefined;
  try {
    return { root: getWorkspaceRoot()!, dbUrl: getDBURL() };
  } catch {
    return undefined;
  }
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const { db } = locals;

  // Read filters from the query for the workspace-wide map. Static exports bake the entire
  // workspace and apply URL selections in the browser.
  const requestedNamespace = prerender ? null : url.searchParams.get("namespaceId");
  const requestedTag = prerender ? null : url.searchParams.get("tag");
  const requestedDay = prerender ? null : url.searchParams.get("day");
  const tag = requestedTag ? normalizeTag(requestedTag) : null;
  if (requestedDay && !validActivityDay(requestedDay)) throw error(400, "Invalid activity day");

  const snapshot = await loadTreemapSnapshot({ db, includeScopes, cache: cacheLocation() });
  const { namespaces } = snapshot;
  if (requestedNamespace && !namespaces.some(({ id }) => id === requestedNamespace))
    throw error(404, "Namespace not found");

  return {
    ...mapView(snapshot, {
      namespaceId: requestedNamespace,
      tag,
      day: requestedDay,
      zoomStep: getWorkspaceUiConfig().zoomStep,
    }),
    ...(!prerender ? { backendCapabilities: httpBackendCapabilities() } : {}),
  };
};
