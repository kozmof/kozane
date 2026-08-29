import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getAllProjects, getProject } from "$db/api/project";
import { getAllBundles } from "$db/api/bundle";
import { getCardBundleNames } from "$db/api/card";
import { getAllTaskspaces } from "$db/api/taskspace";
import type { AnyDB } from "$db/client";
import { getDBURL, getWorkspaceRoot } from "$db/internal/config";
import { loadTagIndex } from "$lib/server/tag-index";
import { buildTagTree, normalizeTag, tagMatcher } from "$lib/tag";
import { TAG_HITS_SHOWN_MAX } from "$lib/constants";
import { applyPalette } from "../[projectId]/lib/project-page.js";
import type { TagHit } from "$lib/types";

// Static export: one tag index for the whole workspace. A static route, so unlike the board
// there are no `entries` to generate — and unlike the board it is not per-project, because
// which project is being looked at is a query parameter now, and a prerender has no query.
export const prerender = process.env.KOZANE_SSG === "1";
// `--include-scoped-files`. A file hit names a path inside the workspace and quotes a line
// of that file, so an export carries file tags only when it was built to carry files at
// all — the same opt-in that governs the taskspace panel. Card tags are board content and
// go out with the rest of it.
const includeScopedFiles = process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES === "1";

/**
 * Where the gather is kept between requests, or nothing when it cannot be.
 *
 * Nothing during a prerender: an export is built once, in a temporary place, and would only
 * leave a cache file behind for a workspace it is not serving. Nothing either when there is
 * no workspace root or no database URL to validate against — see `openTagCache`, which
 * refuses to cache what it cannot check.
 */
function cacheLocation(): { cache: { root: string; dbUrl: string } } | null {
  if (prerender) return null;
  const root = getWorkspaceRoot();
  if (!root) return null;
  try {
    return { cache: { root, dbUrl: getDBURL() } };
  } catch {
    return null;
  }
}

/**
 * A prerendered page has no query string to read, so a static export bakes every hit and the
 * page selects among them in the browser. The live page filters here instead, so opening one
 * tag of a large workspace sends one tag's hits rather than all of them.
 *
 * The `TAG_HITS_SHOWN_MAX` cap is applied to what one tag shows, and so only on the live
 * path: an export is baked before anyone has chosen a tag, and capping the whole set there
 * would drop hits the browser had not yet had the chance to filter down to. The page applies
 * the same cap after it has filtered, so both arrive at a list of the same length.
 */
function selectHits(hits: TagHit[], tag: string | null): { hits: TagHit[]; total: number | null } {
  // Nothing filtered and nothing capped yet, and so nothing to report a total against: the
  // browser does both, and is the only thing in a position to count.
  if (prerender) return { hits, total: null };
  if (!tag) return { hits: [], total: 0 };

  const matches = tagMatcher(tag);
  const matching = hits.filter((hit) => matches(hit.tag));
  return { hits: matching.slice(0, TAG_HITS_SHOWN_MAX), total: matching.length };
}

/**
 * Bundle names and colours for the cards being shown, keyed by bundle.
 *
 * Per project, because the palette is assigned by position within a project's own bundles —
 * the same `applyPalette` over the same `getAllBundles` order the board uses, so a bundle's
 * dot is the same colour here as it is there. Read only for the projects that actually have
 * a card in the list, which is one of them whenever a project is selected.
 */
async function bundlesForProjects(
  db: AnyDB,
  projectIds: string[],
): Promise<Record<string, { name: string; dot: string }>> {
  const byBundle: Record<string, { name: string; dot: string }> = {};
  for (const projectId of projectIds) {
    for (const bundle of applyPalette(await getAllBundles({ db, projectId }))) {
      byBundle[bundle.id] = { name: bundle.name, dot: bundle.dot };
    }
  }
  return byBundle;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const { db } = locals;

  // Both are read from the query rather than the path: the index is one page over the whole
  // workspace, and `?projectId=` narrows it. A prerender has no query, so both are null
  // there and the page reads them from the URL in the browser instead.
  const requestedProject = prerender ? null : url.searchParams.get("projectId");
  const requestedTag = prerender ? null : url.searchParams.get("tag");
  const tag = requestedTag ? normalizeTag(requestedTag) : null;

  // Checked rather than passed through: a `?projectId=` naming nothing would otherwise
  // quietly gather nothing at all and read as a workspace with no tags in it.
  if (requestedProject && !(await getProject({ db, projectId: requestedProject })))
    throw error(404, "Project not found");

  const [index, projects, taskspaces] = await Promise.all([
    loadTagIndex({
      db,
      ...(requestedProject ? { projectId: requestedProject } : {}),
      includeFiles: !prerender || includeScopedFiles,
      // Kept between requests, so clicking from one tag to the next does not re-run the card
      // query and re-read every taskspace file to produce the set it just produced. Skipped
      // where there is no workspace to keep it in, which is a prerender building an export.
      ...cacheLocation(),
    }),
    getAllProjects({ db }),
    getAllTaskspaces({ db }),
  ]);

  const { hits, total: hitTotal } = selectHits(index.hits, tag);
  const shownCardIds = [
    ...new Set(hits.flatMap((hit) => (hit.source.kind === "card" ? [hit.source.cardId] : []))),
  ];
  const shownProjects = [
    ...new Set(shownCardIds.map((cardId) => index.cardProjects[cardId]).filter(Boolean)),
  ];
  const cardBundles = await getCardBundleNames({ db, cardIds: shownCardIds });

  return {
    projectId: requestedProject,
    // Named so the page can title itself and offer the way back to a board.
    projects: projects.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
    // Built from every hit, always: the tree is this page's index, and one narrowed to the
    // selected tag would be a tree with a single branch.
    tree: buildTagTree(index.hits),
    tag,
    hits,
    /** How many hits the tag gathers, against the at-most-`TAG_HITS_SHOWN_MAX` above. Null
     *  in an export, where the browser filters and so does its own counting. */
    hitTotal,
    truncated: index.truncated,
    cardProjects: index.cardProjects,
    taskspaceProjects: index.taskspaceProjects,
    // For labelling hits. Which bundle a card is in, and the name of the taskspace a file
    // sits in, are both things a hit deliberately does not carry — see the note on
    // `TagSource` — so they are joined here, for the hits actually being shown.
    cardBundleIds: Object.fromEntries(cardBundles.map((row) => [row.cardId, row.bundleId])),
    bundles: await bundlesForProjects(db, shownProjects),
    taskspaces: taskspaces.map(({ id, name, projectId }) => ({ id, name, projectId })),
  };
};
