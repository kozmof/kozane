import { getAllCards } from "../../db/api/card.js";
import { getAllBundles } from "../../db/api/bundle.js";
import { getTaskspacesInProject } from "../../db/api/taskspace.js";
import {
  buildTagTree,
  normalizeTag,
  tagMatches,
  type TagCounts,
  type TagNode,
} from "../../lib/tag.js";
import { loadTagIndex } from "../../lib/server/tag-index.js";
import type { DB } from "../../db/tx.js";
import type { TagHit } from "../../lib/types.js";
import { resolveProjectId } from "../lib/project-selection.js";
import { shortIdMap } from "../lib/short-id.js";
import { runWorkspaceCommand } from "../lib/workspace-command.js";

export type TagOptions = { project?: string };
export type TagShowOptions = TagOptions & { files?: boolean };

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
    const { hits, truncated } = await loadTagIndex({
      db,
      projectId,
      includeFiles: true,
      root,
      cache: { root, dbUrl },
    });

    const tree = buildTagTree(hits);
    if (tree.length === 0) {
      console.log("No tags found. Write 'like:this in a card or a taskspace file.");
      return;
    }
    printTree(tree);
    await warnTruncated(db, projectId, truncated);
  });
}

/** Says which taskspaces were not read in full, so a tag missing from the list above is not
 *  read as a tag nobody wrote. */
async function warnTruncated(
  db: DB,
  projectId: string,
  truncated: { taskspaceId: string; reasons: string[] }[],
): Promise<void> {
  if (truncated.length === 0) return;
  const taskspaces = await getTaskspacesInProject({ db, projectId });
  const nameById = new Map(taskspaces.map((taskspace) => [taskspace.id, taskspace.name]));
  for (const { taskspaceId, reasons } of truncated) {
    console.log(
      `Note: ${nameById.get(taskspaceId) || taskspaceId} was not read in full (${reasons.join(", ")}).`,
    );
  }
}

/**
 * What one tag gathers: the cards it is written on and the taskspace files it appears in.
 *
 * A tag gathers its subcategories, so `kozane tag show foo` includes everything written
 * `'foo:bar:baz` — the same rule the index page filters by, via the same `tagMatches`.
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
    const { hits, truncated } = await loadTagIndex({
      db,
      projectId,
      includeFiles,
      root,
      cache: { root, dbUrl },
    });

    const matching = hits.filter((hit) => tagMatches(query, hit.tag));
    if (matching.length === 0) {
      console.log(`No cards or files under '${query}.`);
      return;
    }

    await printCardHits(db, projectId, matching);
    printFileHits(matching);
    await warnTruncated(db, projectId, truncated);
  });
}

async function printCardHits(db: DB, projectId: string, hits: TagHit[]): Promise<void> {
  const cardHits = hits.filter((hit) => hit.source.kind === "card");
  if (cardHits.length === 0) return;

  // Short ids are drawn against every card of the project, so the id printed for a card is
  // the one `kozane card show` takes, whichever tag was asked for.
  const bundles = await getAllBundles({ db, projectId });
  const cards = (
    await Promise.all(bundles.map((bundle) => getAllCards({ db, bundleId: bundle.id })))
  ).flat();
  const shortIds = shortIdMap(cards.map((card) => card.id));

  console.log("Cards:");
  // One row per card, not per hit. A card written `'perf:cache and 'perf` matches a search
  // for `perf` twice, and printing it twice says the tag is on two cards.
  for (const [cardId, rows] of groupHits(cardHits, (hit) =>
    hit.source.kind === "card" ? hit.source.cardId : "",
  )) {
    console.log(`  ${shortIds.get(cardId) ?? cardId}  ${taggedWith(rows)}  ${rows[0].excerpt}`);
  }
}

/** Hits gathered by whatever identifies the row they will be printed on, in first-seen
 *  order — which is the order the underlying read produced. */
function groupHits(hits: TagHit[], key: (hit: TagHit) => string): [string, TagHit[]][] {
  const groups = new Map<string, TagHit[]>();
  for (const hit of hits) {
    const existing = groups.get(key(hit));
    if (existing) existing.push(hit);
    else groups.set(key(hit), [hit]);
  }
  return [...groups];
}

/** The distinct tags a row matched by, so a card found under two of them says which. */
function taggedWith(hits: TagHit[]): string {
  return [...new Set(hits.map(({ tag }) => `'${tag}`))].sort().join(" ");
}

function printFileHits(hits: TagHit[]): void {
  const fileHits = hits.filter((hit) => hit.source.kind === "file");
  if (fileHits.length === 0) return;

  console.log("Files:");
  // Grouped by the line, not by the file: a file may carry the tag in several places, and
  // each is somewhere to go and look. Two tags on one line are still one row.
  for (const [, rows] of groupHits(fileHits, (hit) =>
    hit.source.kind === "file" ? `${hit.source.path}:${hit.source.line}` : "",
  )) {
    const { source } = rows[0];
    if (source.kind !== "file") continue;
    console.log(`  ${source.path}:${source.line}  ${taggedWith(rows)}  ${rows[0].excerpt}`);
  }
}
