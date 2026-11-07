/** The tag hierarchy with card and file counts at each level. */
import type { TagHit } from "../types.js";
import { splitTag } from "./syntax.js";
import { sourceKey } from "./hits.js";

/**
 * Count distinct cards and files per {@link sourceKey}, keeping the two source kinds
 * separate.
 */
export interface TagCounts {
  cards: number;
  files: number;
}

/** One node of the tag hierarchy the index page draws. */
export interface TagNode {
  /** Full path to this node, such as `foo:bar`, used in links. */
  tag: string;
  /** This node's level, such as `bar`, displayed beside its siblings. */
  name: string;
  children: TagNode[];
  /** Hits whose tag is exactly this node. */
  own: TagCounts;
  /** Hits on this node and its descendants, matching `tagMatches` behavior. */
  total: TagCounts;
}

/**
 * Accumulate distinct source sets by kind while building tree counts. Adding numeric counts
 * would double-count sources matching several descendant tags.
 */
type Tally = { cards: Set<string>; files: Set<string> };

type MutableNode = Omit<TagNode, "children" | "own" | "total"> & {
  children: Map<string, MutableNode>;
  own: Tally;
  total: Tally;
};

const emptyTally = (): Tally => ({ cards: new Set(), files: new Set() });

function emptyNode(tag: string, name: string): MutableNode {
  return { tag, name, children: new Map(), own: emptyTally(), total: emptyTally() };
}

const countKeys = ({ cards, files }: Tally): TagCounts => ({
  cards: cards.size,
  files: files.size,
});

// Break case-insensitive ties consistently, as `compareEntries` does for taskspace files.
function compareNodes(a: TagNode, b: TagNode): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return byName !== 0 ? byName : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function freezeNodes(nodes: Iterable<MutableNode>): TagNode[] {
  return [...nodes]
    .map((node) => ({
      tag: node.tag,
      name: node.name,
      children: freezeNodes(node.children.values()),
      own: countKeys(node.own),
      total: countKeys(node.total),
    }))
    .sort(compareNodes);
}

/**
 * Build every level of the tag hierarchy, including unwritten ancestors. `own` counts hits at
 * the exact node, while `total` includes descendants.
 */
export function buildTagTree(hits: TagHit[]): TagNode[] {
  const roots = new Map<string, MutableNode>();

  for (const hit of hits) {
    const key = sourceKey(hit.source);
    const kind = hit.source.kind === "card" ? "cards" : "files";
    const levels = splitTag(hit.tag);
    let siblings = roots;
    let path = "";

    for (const [depth, level] of levels.entries()) {
      path = depth === 0 ? level : `${path}:${level}`;
      let node = siblings.get(level);
      if (!node) {
        node = emptyNode(path, level);
        siblings.set(level, node);
      }
      node.total[kind].add(key);
      if (depth === levels.length - 1) node.own[kind].add(key);
      siblings = node.children;
    }
  }

  return freezeNodes(roots.values());
}
