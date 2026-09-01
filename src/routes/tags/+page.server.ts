import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { getAllProjects, getProject } from "$db/api/project";
import { getAllBundles } from "$db/api/bundle";
import { getCardBundleNames } from "$db/api/card";
import type { AnyDB } from "$db/client";
import { getDBURL, getWorkspaceRoot } from "$db/internal/config";
import { loadTagIndex } from "$lib/server/tag-index";
import { buildTagTree, capHitsByKind, normalizeTag, tagMatcher } from "$lib/tag";
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
// The same flag governs whether the export may *name* a taskspace at all, for the reason
// `loadProjectSnapshot` gates its taskspaces behind `includeScopes`: a taskspace's name is
// the name of a directory on someone's machine, and an export is published. This page was
// reading `getAllTaskspaces` unconditionally and shipping every one of them, which
// contradicted that and `docs/security-matrix.md` with it — and shipped nothing usable
// either, since a plain export carries no file hit for a name to label.
//
// It is no longer a second condition here, which is the point: `loadTagIndex` returns the
// taskspaces it walked, and an export that scans no file walks none. See
// `TagIndex.taskspaces`.
const includeScopedFiles = process.env.KOZANE_SSG_INCLUDE_SCOPED_FILES === "1";

/**
 * Where the gather is kept between requests, or nothing when it cannot be.
 *
 * Nothing during a prerender: an export is built once, in a temporary place, and would only
 * leave a cache file behind for a workspace it is not serving. Nothing either when there is
 * no workspace root or no database URL to validate against — see `openTagCache`, which
 * refuses to cache what it cannot check. The root is `loadTagIndex`'s own; only the database
 * to validate against is named here.
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
 * A prerendered page has no query string to read, so a static export bakes every hit and the
 * page selects among them in the browser. The live page filters here instead, so opening one
 * tag of a large workspace sends one tag's hits rather than all of them.
 *
 * The `TAG_HITS_SHOWN_MAX` cap is applied to what one tag shows, and so only on the live
 * path: an export is baked before anyone has chosen a tag, and capping the whole set there
 * would drop hits the browser had not yet had the chance to filter down to. The page applies
 * the same cap through the same `capHitsByKind` after it has filtered, so both arrive at the
 * same list.
 */
function selectHits(
  hits: TagHit[],
  tag: string | null,
): { hits: TagHit[]; cardTotal: number | null; fileTotal: number | null } {
  // Nothing filtered and nothing capped yet, and so nothing to report a total against: the
  // browser does both, and is the only thing in a position to count.
  if (prerender) return { hits, cardTotal: null, fileTotal: null };
  if (!tag) return { hits: [], cardTotal: 0, fileTotal: 0 };

  const matches = tagMatcher(tag);
  // Per kind, not across the list: `loadTagIndex` returns every card hit before any file
  // hit, so one cap over the whole of it listed no files at all for a tag written on more
  // cards than the ceiling. See `capHitsByKind`.
  //
  // The tag test goes in rather than being a `filter` before the cap, so the only arrays
  // built here are the two capped ones. A workspace at the gather's own ceiling holds a
  // hundred thousand hits, and selecting into a new array first meant a copy of however many
  // of them one tag matched in order to keep two hundred of each kind.
  const { cards, files, cardTotal, fileTotal } = capHitsByKind(hits, TAG_HITS_SHOWN_MAX, (hit) =>
    matches(hit.tag),
  );
  return { hits: [...cards, ...files], cardTotal, fileTotal };
}

/**
 * A lookup record cut to the keys actually named by what is being sent.
 *
 * The two records below are keyed by every tagged card and every walked taskspace in the
 * workspace, while `hits` is capped at a few hundred — so a workspace with thousands of
 * tagged cards shipped a map of all of them to label at most two hundred. The export is the
 * one case that needs them whole: it bakes every hit and the browser does the filtering, so
 * it cannot know in advance which keys it will need.
 *
 * A key with no entry is dropped rather than carried as `undefined`, which is what
 * `JSON.stringify` would do with it anyway.
 */
function narrow<T>(record: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) kept[key] = value;
  }
  return kept;
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
  // Read together rather than one project after the next. Nothing here depends on anything
  // else here — each project's palette is assigned within its own bundles — and gathering
  // across a workspace asks about as many projects as it has.
  const palettes = await Promise.all(
    projectIds.map(async (projectId) => applyPalette(await getAllBundles({ db, projectId }))),
  );

  const byBundle: Record<string, { name: string; dot: string }> = {};
  for (const bundles of palettes) {
    for (const bundle of bundles) byBundle[bundle.id] = { name: bundle.name, dot: bundle.dot };
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

  // The live page always reads taskspace files; only a prerendered export's build-time flag
  // decides whether file hits are baked in at all.
  const includeFiles = prerender ? includeScopedFiles : true;

  // Checked rather than passed through: a `?projectId=` naming nothing would otherwise
  // quietly gather nothing at all and read as a workspace with no tags in it.
  if (requestedProject && !(await getProject({ db, projectId: requestedProject })))
    throw error(404, "Project not found");

  const [index, projects] = await Promise.all([
    loadTagIndex({
      db,
      ...(requestedProject ? { projectId: requestedProject } : {}),
      includeFiles,
      // Kept between requests, so clicking from one tag to the next does not re-run the card
      // query and re-read every taskspace file to produce the set it just produced. Skipped
      // where there is no workspace to keep it in, which is a prerender building an export.
      ...cacheLocation(),
    }),
    getAllProjects({ db }),
  ]);

  const { hits, cardTotal, fileTotal } = selectHits(index.hits, tag);
  const shownCardIds = [
    ...new Set(hits.flatMap((hit) => (hit.source.kind === "card" ? [hit.source.cardId] : []))),
  ];
  // `flatMap` over an optional read, rather than `map(...).filter(Boolean)`. Every card
  // carrying a hit has an entry — `getCardTagHits` writes one before it writes the hit — but
  // a lookup can still miss, and `filter(Boolean)` narrows nothing, so the one thing standing
  // between an absent entry and `getAllBundles({ projectId: undefined })` would be a filter
  // the types could not see. `CardTagHits.cardProjects` says the value is optional now, so
  // this is the type being followed rather than an annotation working around it.
  const shownProjects = [
    ...new Set(
      shownCardIds.flatMap((cardId) => {
        const projectId = index.cardProjects[cardId];
        return projectId ? [projectId] : [];
      }),
    ),
  ];
  // Both read the cards being shown and neither reads the other, so they go together — the
  // last round trip of the load rather than the last two.
  const [cardBundles, bundles] = await Promise.all([
    getCardBundleNames({ db, cardIds: shownCardIds }),
    bundlesForProjects(db, shownProjects),
  ]);

  // Only what the rows being sent actually name, except in an export — see `narrow`. The
  // taskspaces are those the file rows sit in, plus any the gather has a warning to give
  // about, since that warning names one. A taskspace that could not be opened is exactly such
  // a one, and the only place its name can come from: it contributed no hit to name it by.
  const shownTaskspaceIds = new Set([
    ...hits.flatMap((hit) => (hit.source.kind === "file" ? [hit.source.taskspaceId] : [])),
    ...index.truncated.map(({ taskspaceId }) => taskspaceId),
    ...index.missing,
  ]);

  return {
    projectId: requestedProject,
    // Named so the page can title itself and offer the way back to a board.
    projects: projects.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
    // Built from every hit, always: the tree is this page's index, and one narrowed to the
    // selected tag would be a tree with a single branch.
    tree: buildTagTree(index.hits),
    tag,
    hits,
    /** How many hits of each kind the tag gathers, against the at-most-`TAG_HITS_SHOWN_MAX`
     *  of each above. Null in an export, where the browser filters and so does its own
     *  counting. Two numbers because there are two ceilings — one total could not say which
     *  of the two lists had been cut. */
    cardTotal,
    fileTotal,
    truncated: index.truncated,
    /** The taskspaces whose directory the gather could not open at all — a record left behind
     *  by a directory that has been deleted or moved. Beside `truncated` and not among it:
     *  such a taskspace was not read in part, it was not read. See `TagIndex.missing`. */
    missing: index.missing,
    /** Whether the card side stopped at its own ceiling. Beside `truncated` rather than
     *  inside it, and drawn beside it too: to a reader whose tag is missing, "not every card
     *  was read" and "not every file was read" are one fact. See `TagIndex.cardsTruncated`. */
    cardsTruncated: index.cardsTruncated,
    cardProjects: prerender ? index.cardProjects : narrow(index.cardProjects, shownCardIds),
    // For labelling hits. Which bundle a card is in, and the name of the taskspace a file
    // sits in, are both things a hit deliberately does not carry — see the note on
    // `TagSource` — so they are joined here, for the hits actually being shown.
    cardBundleIds: Object.fromEntries(cardBundles.map((row) => [row.cardId, row.bundleId])),
    bundles,
    // Empty in a plain export, because such an export walks no taskspace and so has none to
    // name. Nothing on the page needs it there either: the only rows a name labels are file
    // rows, which such an export does not carry.
    taskspaces: prerender ? index.taskspaces : narrow(index.taskspaces, shownTaskspaceIds),
  };
};
