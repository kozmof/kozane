import type { EntryGenerator, PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getDb } from "$db/client";
import { getAllNamespaces } from "$db/api/namespace";
import { loadNamespaceSnapshot } from "./lib/namespace-snapshot.js";
import { getWorkspaceUiConfig } from "$db/internal/config";
import { loadWarpDirectory } from "$lib/server/warp-directory";
import { isSsgBuild, ssgIncludesScopedFiles } from "$lib/server/ssg";

// Prerender one page per namespace for static exports. `entries` supplies namespace IDs, and
// `readonly` disables editing controls and live polling.
export const prerender = isSsgBuild();
const readonly = process.env.KOZANE_READONLY === "1";
// Include scope organization and taskspace file contents only when `--include-scoped-files`
// is requested.
const includeScopedFiles = ssgIncludesScopedFiles();

export const entries: EntryGenerator = async () => {
  // Only touch the database when actually building the static export. A normal
  // (adapter-node) build still evaluates this generator but has no workspace.
  if (!prerender) return [];
  const db = await getDb();
  const namespaces = await getAllNamespaces({ db });
  return namespaces.map((p) => ({ namespaceId: p.id }));
};

export const load: PageServerLoad = async ({ locals, params }) => {
  const { db } = locals;
  const { namespaceId } = params;

  // The same read `/api/snapshot` makes, so the board this page opens on and the board the
  // poll keeps it at are assembled by one piece of code rather than two.
  const [loaded, allNamespaces, warpDirectory] = await Promise.all([
    loadNamespaceSnapshot({
      db,
      namespaceId,
      includeTaskspacePaths: !prerender,
      // Live boards include scopes. Static exports include them only with
      // `--include-scoped-files`.
      includeScopes: !prerender || includeScopedFiles,
      includeScopedFiles: prerender && includeScopedFiles,
    }),
    getAllNamespaces({ db }),
    // The other namespaces' warps, for the Shift+arrow palette. Baked into a static export
    // too, which is why the palette works there without an endpoint to call. Independent
    // of the board itself, so it is read alongside rather than after it.
    loadWarpDirectory({ db, namespaceId }),
  ]);
  if (!loaded) throw error(404, "Namespace not found");

  return {
    ...loaded.snapshot,
    namespace: loaded.namespace,
    warpDirectory,
    otherNamespaces: allNamespaces.filter((p) => p.id !== namespaceId),
    uiConfig: getWorkspaceUiConfig(),
    readonly,
  };
};
