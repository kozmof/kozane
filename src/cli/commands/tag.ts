import { getProjectCardIds } from "../../db/api/card.js";
import {
  buildTagTree,
  capHitsByKind,
  groupHitRows,
  normalizeTag,
  taggedWith,
  tagMatcher,
  truncationReasons,
  type CappedHits,
  type TagCounts,
  type TagHitOf,
  type TagNode,
} from "../../lib/tag.js";
import { TAG_HITS_SHOWN_MAX } from "../../lib/constants.js";
import {
  loadTagIndex,
  type TagIndexTaskspace,
  type TagIndexTruncation,
} from "../../lib/server/tag-index.js";
import type { DB } from "../../db/tx.js";
import type { TagHit } from "../../lib/types.js";
import { resolveProjectId } from "../lib/project-selection.js";
import { shortIdMap } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export type TagOptions = { project?: string };
export type TagShowOptions = TagOptions & { files?: boolean };

/**
 * What a node gathers, spelled out — `1 card, 2 files`.
 *
 * Deliberately not what the tag index page prints, which is the bare total. The page draws
 * its tree in a narrow column beside the hits, where a number is all that fits and the panel
 * beside it says which kind each row is; a terminal line has room, and `kozane tag list`
 * prints no panel afterwards to say so. Same counts from the same `TagCounts` either way —
 * only the wording differs, and it differs because the space does.
 */
const countLabel = ({ cards, files }: TagCounts): string =>
  [
    cards ? `${cards} card${cards === 1 ? "" : "s"}` : "",
    files ? `${files} file${files === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");

/** The tree, indented by depth. A tag prints with its sigil, so what is on screen is what
 *  would be typed into a card to write it. */
function printTree(nodes: TagNode[], depth = 0): void {
  for (const node of nodes) {
    console.log(`${"  ".repeat(depth)}'${node.name}  ${countLabel(node.total)}`);
    printTree(node.children, depth + 1);
  }
}

/**
 * Every tag in a project, as a tree.
 *
 * Reads exactly what the tag index page reads — `loadTagIndex` — so the terminal and
 * the browser cannot come to different conclusions about what a tag holds.
 */
export async function tagList(options: TagOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root, dbUrl }) => {
    const projectId = await resolveProjectId(db, options.project);
    // The cache matters most here. A command runs in a process that exits, so without one
    // every invocation re-queries every card and re-reads every taskspace file to learn what
    // the last invocation already worked out.
    const { hits, truncated, taskspaces } = await loadTagIndex({
      db,
      projectId,
      includeFiles: true,
      root,
      cache: { dbUrl },
    });

    const tree = buildTagTree(hits);
    if (tree.length === 0) {
      console.log("No tags found. Write 'like:this in a card or a taskspace file.");
      return;
    }
    printTree(tree);
    warnTruncated(truncated, taskspaces);
  });
}

/** What to call a taskspace the gather walked, falling back to its id. Every id printed came
 *  out of that same gather, so the fallback is for a row the walk somehow did not record
 *  rather than for one it never saw. */
const nameOf = (taskspaces: Record<string, TagIndexTaskspace>, id: string): string =>
  taskspaces[id]?.name || id;

/**
 * Says which taskspaces were not read in full, so a tag missing from the list above is not
 * read as a tag nobody wrote.
 *
 * Names and wording both come from elsewhere. The name is joined from the gather's own record
 * of what it walked — this had been fetching every taskspace in the project again to turn an
 * id back into a name. The wording is `truncationReasons`, shared with the tag index page,
 * because the two say the same thing about the same taskspace and the scanner's own
 * vocabulary — `budget`, `nodes` — was reaching the screen unchanged.
 */
function warnTruncated(
  truncated: TagIndexTruncation[],
  taskspaces: Record<string, TagIndexTaskspace>,
): void {
  for (const { taskspaceId, reasons } of truncated) {
    console.log(
      `Note: ${nameOf(taskspaces, taskspaceId)} was not read in full — ${truncationReasons(reasons)}.`,
    );
  }
}

/**
 * Says which of a list is being printed, when it is not all of it. The page's wording for
 * the same cut, in a sentence rather than a paragraph.
 */
function cappedNote(shown: number, total: number, noun: string): void {
  if (shown < total) console.log(`  … showing the first ${shown} of ${total} ${noun}.`);
}

/**
 * What one tag gathers: the cards it is written on and the taskspace files it appears in.
 *
 * A tag gathers its subcategories, so `kozane tag show foo` includes everything written
 * `'foo:bar:baz` — the same rule the index page filters by, via the same `tagMatches`.
 *
 * Capped at {@link TAG_HITS_SHOWN_MAX} per kind, through the same `capHitsByKind` the page
 * caps with. It was uncapped, on the reasoning that a terminal can be piped to `less` — but
 * the ceiling is not there to protect the screen. A tag written in a shared header comment
 * reaches every file carrying that header, and forty thousand lines is not a more useful
 * answer than two hundred that says how many there were. Per kind for the reason the page
 * gives: the hits arrive cards first, so one ceiling across both would print no files at all
 * for a much-tagged card set.
 */
export async function tagShow(tag: string, options: TagShowOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root, dbUrl }) => {
    // The sigil is optional here: `kozane tag show 'foo` is what someone reading a card
    // would type, and most shells eat the quote unless it is escaped — so both forms work.
    const query = normalizeTag(tag.replace(/^'/, ""));
    if (!query) throw new Error("Tag cannot be empty.");

    const projectId = await resolveProjectId(db, options.project);
    // `--no-files` is commander's spelling of a `--files` that defaults to true.
    const includeFiles = options.files !== false;
    const { hits, truncated, taskspaces } = await loadTagIndex({
      db,
      projectId,
      includeFiles,
      root,
      cache: { dbUrl },
    });

    const matches = tagMatcher(query);
    const matching = hits.filter((hit) => matches(hit.tag));
    if (matching.length === 0) {
      console.log(`No cards or files under '${query}.`);
      return;
    }

    const shown = capHitsByKind(matching, TAG_HITS_SHOWN_MAX);
    await printCardHits(db, projectId, shown);
    printFileHits(shown, taskspaces);
    warnTruncated(truncated, taskspaces);
  });
}

async function printCardHits(
  db: DB,
  projectId: string,
  { cards: cardHits, cardTotal }: CappedHits<TagHit>,
): Promise<void> {
  if (cardHits.length === 0) return;

  // Short ids are drawn against every card of the project, so the id printed for a card is
  // the one `kozane card show` takes, whichever tag was asked for. Ids alone, in one
  // statement: this was a bundle read followed by a card read per bundle, which is a round
  // trip per bundle and the full text of every card in the project, to number them.
  const shortIds = shortIdMap(await getProjectCardIds(db, projectId));

  console.log("Cards:");
  // One row per card, not per hit — `groupHitRows` is what decides that, and decides it once
  // for the terminal and the index page alike. A card written `'perf:cache and 'perf` matches
  // a search for `perf` twice, and printing it twice says the tag is on two cards.
  for (const { source, hits: rows } of groupHitRows(cardHits)) {
    const id = shortIds.get(source.cardId) ?? source.cardId;
    console.log(`  ${id}  ${taggedWith(rows).join(" ")}  ${rows[0].excerpt}`);
  }
  // Of hits rather than of the rows above, which is what was cut: the cap is applied before
  // the grouping, so a card carrying the tag twice is one row out of two hits.
  cappedNote(cardHits.length, cardTotal, "card hits");
}

/**
 * The file rows, under the taskspace each was found in.
 *
 * Grouped by taskspace first, because a path is relative to one and says nothing on its own:
 * a project draws its own taskspaces *and* every unplaced one, so `README.md:2` printed bare
 * was two indistinguishable rows for two different files as soon as a workspace had a second
 * taskspace. The tag index page had always headed its file rows this way; this is the same
 * grouping, in the terminal's shape.
 *
 * Within a taskspace, grouped by the line rather than by the file: a file may carry the tag
 * in several places, and each is somewhere to go and look. Two tags on one line are still one
 * row.
 */
function printFileHits(
  { files: fileHits, fileTotal }: CappedHits<TagHit>,
  taskspaces: Record<string, TagIndexTaskspace>,
): void {
  if (fileHits.length === 0) return;

  const byTaskspace = new Map<string, TagHitOf<TagHit, "file">[]>();
  for (const hit of fileHits) {
    const existing = byTaskspace.get(hit.source.taskspaceId);
    if (existing) existing.push(hit);
    else byTaskspace.set(hit.source.taskspaceId, [hit]);
  }

  console.log("Files:");
  for (const [taskspaceId, hits] of byTaskspace) {
    console.log(`  ${nameOf(taskspaces, taskspaceId)}:`);
    for (const { source, hits: rows } of groupHitRows(hits)) {
      console.log(
        `    ${source.path}:${source.line}  ${taggedWith(rows).join(" ")}  ${rows[0].excerpt}`,
      );
    }
  }
  cappedNote(fileHits.length, fileTotal, "file hits");
}
