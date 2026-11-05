import { httpErrorFromDb } from "../[namespaceId]/lib/api-handler.js";
import type { PageServerLoad } from "./$types";
import * as namespacesService from "../../services/namespaces.js";
import { displayMetadata } from "../../services/tags.js";
import { workspaceServiceContext } from "$lib/server/service-context";
import { getDBURL, getWorkspaceRoot } from "$db/internal/config";
import { loadTagIndex } from "$lib/server/tag-index";
import { normalizeTag } from "$lib/tag";
import { selectTagHits, tagsView } from "$lib/backend/views/tags.js";
import { pageBackendData } from "$lib/server/page-backend.js";
import { isSsgBuild, ssgIncludesScopedFiles } from "$lib/server/ssg";

// Prerender one workspace-wide tag index. Namespace filtering uses query parameters at
// runtime.
export const prerender = isSsgBuild();
// Include file tags only when static export requests scoped files because hits expose paths
// and excerpts. Taskspace metadata comes from the gather, so an export that scans no files
// also publishes no taskspace names.
const includeScopedFiles = ssgIncludesScopedFiles();

/**
 * Enable persistent caching only with a workspace root and verifiable database URL. Skip it
 * during prerendering, which has no later requests to reuse it.
 */
function cacheLocation(): { cache: { dbUrl: string } } | null {
  if (prerender || !getWorkspaceRoot()) return null;
  try {
    return { cache: { dbUrl: getDBURL() } };
  } catch {
    return null;
  }
}

/**
 * Read partition names and colors for displayed cards. Assign each namespace's palette in the
 * same order as its board, and read only namespaces used by the results.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
  const { db } = locals;

  // Read workspace-wide tag-index filters from the query. During prerendering, leave them
  // null and let the browser apply URL selections.
  const requestedNamespace = prerender ? null : url.searchParams.get("namespaceId");
  const requestedTag = prerender ? null : url.searchParams.get("tag");
  const tag = requestedTag ? normalizeTag(requestedTag) : null;

  // Live pages scan taskspace files. Static exports do so only when requested at build time.
  const includeFiles = prerender ? includeScopedFiles : true;

  // Reject unknown namespaces instead of presenting an empty tag index as a valid result.
  if (requestedNamespace) {
    try {
      await namespacesService.get(db, workspaceServiceContext(), requestedNamespace);
    } catch (failure) {
      throw httpErrorFromDb(failure);
    }
  }

  const [index, namespaces] = await Promise.all([
    loadTagIndex({
      db,
      ...(requestedNamespace ? { namespaceId: requestedNamespace } : {}),
      includeFiles,
      // Reuse the cached index across tag selections to avoid repeating unchanged scans.
      // Static prerendering skips persistent caching.
      ...cacheLocation(),
    }),
    namespacesService.list(db, workspaceServiceContext()),
  ]);

  const { hits } = selectTagHits(index.hits, tag, prerender);
  const shownCardIds = [
    ...new Set(hits.flatMap((hit) => (hit.source.kind === "card" ? [hit.source.cardId] : []))),
  ];
  // Drop missing card-to-namespace lookups before requesting partition data. Use explicit
  // narrowing so undefined IDs cannot reach the query.
  const shownNamespaces = [
    ...new Set(
      shownCardIds.flatMap((cardId) => {
        const namespaceId = index.cardNamespaces[cardId];
        return namespaceId ? [namespaceId] : [];
      }),
    ),
  ];
  // Read independent card metadata concurrently.
  const { cardPartitions, partitions } = await displayMetadata(
    db,
    workspaceServiceContext(),
    shownCardIds,
    shownNamespaces,
  );

  return {
    ...tagsView(
      { index, namespaces, cardPartitions, partitions },
      { namespaceId: requestedNamespace, tag, staticExport: prerender },
    ),
    ...pageBackendData(prerender, {
      namespaces,
      tags: { index, namespaces, cardPartitions, partitions },
    }),
  };
};
