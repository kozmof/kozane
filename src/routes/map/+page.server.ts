import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getAllProjects, getProject } from "$db/api/project";
import { getAllBundles, getBundleCardCounts } from "$db/api/bundle";
import { getAllScopes, getScopeBundleUsage, getScopeProjectUsage } from "$db/api/scope";
import { getCardChangeCounts } from "$db/api/card";
import type { AnyDB } from "$db/client";
import { getDBURL, getWorkspaceRoot, getWorkspaceUiConfig } from "$db/internal/config";
import { normalizeTag } from "$lib/tag";
import { loadTagIndex } from "$lib/server/tag-index";
import { applyPalette } from "../[projectId]/lib/project-page.js";
import { validActivityDay } from "./lib/activity.js";

/**
 * The whole workspace at once: every project as a rectangle, its bundles inside it sized by
 * how many cards they hold, the scopes that reach across them as a graph over the packing,
 * and the tags as the tree they spell.
 *
 * A read, and only a read. There are no actions here and no snapshot poll — the board is
 * where a workspace is changed, and this page is where its shape is looked at.
 *
 * **Cards only, and no filesystem.** The shared tag index is loaded with files disabled, so
 * its persisted card gather can serve this page without exposing or walking taskspace files.
 * Its cached card dimensions let the browser regroup the same hits by bundle and change day.
 */

// Static export: one map of the workspace, prerendered. A static route with no `entries` to
// generate, for the reason `/tags` has none — which project is being looked at is a query
// parameter, and a prerender has no query to read.
export const prerender = process.env.KOZANE_SSG === "1";

/**
 * Whether a prerender may draw scopes at all.
 *
 * A plain `kozane net ssg generate` carries no scopes: `loadProjectSnapshot` gates them
 * behind `includeScopes`, and `docs/security-matrix.md` states it as a promise about what an
 * export publishes. A scope name is workspace content someone chose not to publish, and this
 * page would be the one place it went out anyway — so the whole scope graph is gathered only
 * under the same `--include-scoped-files` that every other page's scopes are.
 *
 * It gates the gather rather than the drawing, deliberately. A page that fetched the scopes
 * and then declined to render them would still have baked them into the JSON the export
 * ships beside the HTML.
 */
const includeScopedFiles = process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES === "1";
const includeScopes = !prerender || includeScopedFiles;

function cacheLocation(): { cache: { dbUrl: string } } | null {
  if (prerender || !getWorkspaceRoot()) return null;
  try {
    return { cache: { dbUrl: getDBURL() } };
  } catch {
    return null;
  }
}

/** A bundle as the map draws it: what it is, how much it holds, and the colour its own board
 *  gives it. */
export type MapBundle = {
  id: string;
  projectId: string;
  name: string;
  isDefault: boolean;
  cards: number;
  bg: string;
  dot: string;
};

/**
 * One line from a scope's node. A scope reaches a bundle by a card filed into it, and reaches
 * a project — with no bundle to name — by a taskspace attached to it. Both are lines to draw,
 * so both are spokes, and `kind` says which rectangle the other end is.
 */
export type MapSpoke = { kind: "bundle" | "project"; id: string; cards: number };
export type MapScope = { id: string; name: string; spokes: MapSpoke[] };

/**
 * The board's colours, by bundle id.
 *
 * Read through `getAllBundles` per project rather than off {@link getBundleCardCounts},
 * though that already names every bundle there is. The palette is assigned by a bundle's
 * *position* among its project's own bundles (see `applyPalette`), so a colour can only be
 * worked out from the same list, in the same order, that the board itself reads — an
 * aggregate grouped by id is not that list. The alternative is a map whose colours drift
 * from the boards it is a map of, which is the one thing the colours are for.
 *
 * The reads go together rather than one project after the next: nothing here depends on
 * anything else here, since each project's palette is assigned within its own bundles. The
 * same shape, and the same argument, as `bundlesForProjects` on the tag index.
 */
async function paletteByBundle(
  db: AnyDB,
  projectIds: string[],
): Promise<Record<string, { bg: string; dot: string }>> {
  const palettes = await Promise.all(
    projectIds.map(async (projectId) => applyPalette(await getAllBundles({ db, projectId }))),
  );
  const colours: Record<string, { bg: string; dot: string }> = {};
  for (const bundles of palettes) {
    for (const { id, bg, dot } of bundles) colours[id] = { bg, dot };
  }
  return colours;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const { db } = locals;

  // Both read from the query rather than the path, as on the tag index: the map is one page
  // over the whole workspace and `?projectId=` narrows it. A prerender has no query, so the
  // export bakes the whole workspace and the browser reads the selection from the URL.
  const requestedProject = prerender ? null : url.searchParams.get("projectId");
  const requestedTag = prerender ? null : url.searchParams.get("tag");
  const requestedDay = prerender ? null : url.searchParams.get("day");
  const tag = requestedTag ? normalizeTag(requestedTag) : null;
  if (requestedDay && !validActivityDay(requestedDay)) throw error(400, "Invalid activity day");

  // Checked rather than passed through, for the reason the tag index checks it: a
  // `?projectId=` naming nothing narrows every read below to nothing and draws as an empty
  // workspace rather than as a bad link.
  if (requestedProject && !(await getProject({ db, projectId: requestedProject })))
    throw error(404, "Project not found");

  const [projects, counts, tagIndex, activity] = await Promise.all([
    getAllProjects({ db }),
    getBundleCardCounts({ db }),
    loadTagIndex({
      db,
      ...(requestedProject ? { projectId: requestedProject } : {}),
      includeFiles: false,
      ...cacheLocation(),
    }),
    getCardChangeCounts({
      db,
      ...(requestedProject ? { projectIds: [requestedProject] } : {}),
    }),
  ]);

  const drawn = requestedProject ? projects.filter(({ id }) => id === requestedProject) : projects;
  const drawnProjects = new Set(drawn.map(({ id }) => id));
  const bundleRows = counts.filter(({ projectId }) => drawnProjects.has(projectId));
  const onMap = new Set(bundleRows.map(({ id }) => id));

  // The cards carrying a tag, and the scopes reaching across the map. Nothing here depends on
  // anything else here.
  const [colours, scopes, bundleUsage, projectUsage] = await Promise.all([
    paletteByBundle(db, [...drawnProjects]),
    includeScopes ? getAllScopes({ db }) : Promise.resolve([]),
    includeScopes ? getScopeBundleUsage({ db }) : Promise.resolve([]),
    includeScopes ? getScopeProjectUsage({ db }) : Promise.resolve([]),
  ]);

  const bundles: MapBundle[] = bundleRows.map((row) => ({
    ...row,
    ...(colours[row.id] ?? { bg: "transparent", dot: "currentColor" }),
  }));

  const spokesByScope = new Map<string, MapSpoke[]>();
  for (const { scopeId, bundleId, cards } of bundleUsage) {
    if (!onMap.has(bundleId)) continue;
    const spokes = spokesByScope.get(scopeId) ?? [];
    spokes.push({ kind: "bundle", id: bundleId, cards });
    spokesByScope.set(scopeId, spokes);
  }
  // A scope reaching a project only through a taskspace has no card and so no bundle, and
  // would vanish from a graph drawn from `scope_rel` alone. Those reach the project
  // rectangle instead — but only where the same scope has no bundle spoke into that project
  // already, or a scope with both would be drawn twice into one project.
  const bundleProject = new Map(bundleRows.map(({ id, projectId }) => [id, projectId]));
  for (const { scopeId, projectId } of projectUsage) {
    if (!drawnProjects.has(projectId)) continue;
    const spokes = spokesByScope.get(scopeId) ?? [];
    if (
      spokes.some((spoke) => spoke.kind === "bundle" && bundleProject.get(spoke.id) === projectId)
    )
      continue;
    spokes.push({ kind: "project", id: projectId, cards: 0 });
    spokesByScope.set(scopeId, spokes);
  }

  return {
    /**
     * How far one notch of the wheel, or one press of the zoom control, moves the zoom.
     *
     * `ui.zoomStep` and nothing else from the ui config: the map has no cards to size and no
     * panels to open, and `ui.defaultZoom` is deliberately left out — see `FITTED_VIEW`.
     * Shared with the board because it is a setting about the input device rather than about
     * either page, so a workspace that has tuned its wheel has tuned both.
     */
    zoomStep: getWorkspaceUiConfig().zoomStep,
    /** Which project the map was narrowed to, or null for the whole workspace. */
    projectId: requestedProject,
    projects: projects.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
    /** The projects actually packed, which is all of them unless `?projectId=` narrowed it. */
    drawn: drawn.map(({ id, name }) => ({ id, name })),
    bundles,
    /**
     * Only the scopes with somewhere to point. A scope nobody has put anything in yet is a
     * hub with no spokes, and a node floating under the packing attached to nothing says
     * less than leaving it out does — `kozane scope list` is where a workspace's scopes are
     * enumerated. Empty in a plain static export; see `includeScopes`.
     */
    scopes: scopes
      .filter(({ id }) => spokesByScope.has(id))
      .map(({ id, name }): MapScope => ({ id, name, spokes: spokesByScope.get(id) ?? [] })),
    tagHits: tagIndex.hits,
    tagCards: tagIndex.cardData,
    tag,
    day: requestedDay,
    activity,
    /** Whether the card gather stopped at `TAG_CARD_HITS_MAX`, so the tree counts are a floor
     *  rather than the whole. The same flag the tag index draws, for the same reason. */
    cardsTruncated: tagIndex.cardsTruncated,
  };
};
