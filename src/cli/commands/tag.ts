import { getNamespaceCardIds } from "../../db/api/card.js";
import {
  buildTagTree,
  capHitsByKind,
  groupHitRows,
  groupHitsByTaskspace,
  normalizeTag,
  taggedWith,
  tagMatcher,
  truncationReasons,
  truncationPaths,
  missingTaskspaceLabel,
  cleanupCommandTail,
  CARDS_TRUNCATED_LABEL,
  TASKSPACE_CLEANUP_COMMAND,
  type CappedHits,
  type TagCounts,
  type TagNode,
} from "../../lib/tag.js";
import { TAG_HITS_SHOWN_MAX, TAG_SIGIL } from "../../lib/constants.js";
import {
  loadTagIndex,
  type TagIndexTaskspaces,
  type TagIndexTruncation,
} from "../../lib/server/tag-index.js";
import type { DB } from "../../db/tx.js";
import type { TagHit } from "../../lib/types.js";
import { resolveNamespaceId } from "../lib/namespace-selection.js";
import { shortIdMap } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export type TagOptions = { namespace?: string };
export type TagShowOptions = TagOptions & { files?: boolean };

/**
 * Format counts by kind, such as `1 card, 2 files`. The CLI has no adjacent results panel to
 * distinguish the kinds, so it needs more detail than the tag index's total.
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
    console.log(`${"  ".repeat(depth)}${TAG_SIGIL}${node.name}  ${countLabel(node.total)}`);
    printTree(node.children, depth + 1);
  }
}

/** List namespace tags as a tree using the same `loadTagIndex` reader as the browser. */
export async function tagList(options: TagOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root, dbUrl }) => {
    const namespaceId = await resolveNamespaceId(db, options.namespace);
    // The cache matters most here. A command runs in a process that exits, so without one
    // every invocation re-queries every card and re-reads every taskspace file to learn what
    // the last invocation already worked out.
    const { hits, truncated, missing, taskspaces, cardsTruncated } = await loadTagIndex({
      db,
      namespaceId,
      includeFiles: true,
      root,
      cache: { dbUrl },
    });

    const tree = buildTagTree(hits);
    if (tree.length === 0) {
      console.log(`No tags found. Write ${TAG_SIGIL}like:this in a card or a taskspace file.`);
      return;
    }
    printTree(tree);
    warnIncomplete({ truncated, missing, taskspaces, cardsTruncated });
  });
}

/** What to call a taskspace the gather walked, falling back to its id. Every id printed came
 *  out of that same gather, so the fallback is for a row the walk somehow did not record
 *  rather than for one it never saw. */
const nameOf = (taskspaces: TagIndexTaskspaces, id: string): string => taskspaces[id]?.name || id;

type WarnIncomplete = {
  truncated: TagIndexTruncation[];
  missing: string[];
  taskspaces: TagIndexTaskspaces;
  cardsTruncated: boolean;
};

/**
 * Report incomplete card and file scans and unavailable taskspaces. Use gathered taskspace
 * metadata and shared labels so CLI and page diagnostics agree. Include sample paths and one
 * cleanup suggestion for missing records.
 */
function warnIncomplete({ truncated, missing, taskspaces, cardsTruncated }: WarnIncomplete): void {
  // Report card truncation before taskspace file warnings.
  if (cardsTruncated) console.log(`Note: ${CARDS_TRUNCATED_LABEL}.`);
  for (const { taskspaceId, reasons, paths } of truncated) {
    console.log(
      `Note: ${nameOf(taskspaces, taskspaceId)} was not read in full — ${truncationReasons(reasons)}${truncationPaths(paths)}.`,
    );
  }
  for (const taskspaceId of missing) {
    console.log(`Note: ${missingTaskspaceLabel(nameOf(taskspaces, taskspaceId))}.`);
  }
  // Print the repair command once after all affected taskspaces.
  if (missing.length > 0) {
    console.log(`  Run \`${TASKSPACE_CLEANUP_COMMAND}\` ${cleanupCommandTail(missing.length)}`);
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
 * List cards and file lines matching a tag or its descendants through `tagMatches`. Apply
 * {@link TAG_HITS_SHOWN_MAX} separately to each kind so card hits cannot hide all file hits.
 */
export async function tagShow(tag: string, options: TagShowOptions = {}): Promise<void> {
  await runWorkspaceCommand(async ({ db, root, dbUrl }) => {
    // Accept tag names with or without the leading sigil.
    const query = normalizeTag(tag.replace(/^:/, ""));
    if (!query) throw new Error("Tag cannot be empty.");

    const namespaceId = await resolveNamespaceId(db, options.namespace);
    // `--no-files` is commander's spelling of a `--files` that defaults to true.
    const includeFiles = options.files !== false;
    const { hits, truncated, missing, taskspaces, cardsTruncated } = await loadTagIndex({
      db,
      namespaceId,
      includeFiles,
      root,
      cache: { dbUrl },
    });

    const matches = tagMatcher(query);
    // Select matches while applying display caps. Retain totals for all matches to
    // distinguish empty results from truncated ones.
    const shown = capHitsByKind(hits, TAG_HITS_SHOWN_MAX, (hit) => matches(hit.tag));
    if (shown.cardTotal === 0 && shown.fileTotal === 0) {
      console.log(`No cards or files under ${TAG_SIGIL}${query}.`);
      return;
    }

    await printCardHits(db, namespaceId, shown);
    printFileHits(shown, taskspaces);
    warnIncomplete({ truncated, missing, taskspaces, cardsTruncated });
  });
}

async function printCardHits(
  db: DB,
  namespaceId: string,
  { cards: cardHits, cardTotal }: CappedHits<TagHit>,
): Promise<void> {
  if (cardHits.length === 0) return;

  // Build short IDs from every card ID in the namespace so displayed prefixes remain
  // unambiguous outside this tag result. Read only IDs in one query.
  const shortIds = shortIdMap(await getNamespaceCardIds({ db, namespaceId }));

  console.log("Cards:");
  // Use shared grouping to print each card once even when several tags on it match.
  for (const { source, hits: rows } of groupHitRows(cardHits)) {
    const id = shortIds.get(source.cardId) ?? source.cardId;
    console.log(`  ${id}  ${taggedWith(rows).join(" ")}  ${rows[0].excerpt}`);
  }
  // Count omitted hits before row grouping, matching the stage where the cap applies.
  cappedNote(cardHits.length, cardTotal, "card hits");
}

/**
 * Group file hits by taskspace so identical relative paths remain distinguishable. Within
 * each taskspace, show one row per matching line, combining multiple hits on that line.
 */
function printFileHits(
  { files: fileHits, fileTotal }: CappedHits<TagHit>,
  taskspaces: TagIndexTaskspaces,
): void {
  if (fileHits.length === 0) return;

  console.log("Files:");
  for (const { taskspaceId, rows: taskspaceRows } of groupHitsByTaskspace(fileHits)) {
    console.log(`  ${nameOf(taskspaces, taskspaceId)}:`);
    for (const { source, hits: rows } of taskspaceRows) {
      console.log(
        `    ${source.path}:${source.line}  ${taggedWith(rows).join(" ")}  ${rows[0].excerpt}`,
      );
    }
  }
  cappedNote(fileHits.length, fileTotal, "file hits");
}
