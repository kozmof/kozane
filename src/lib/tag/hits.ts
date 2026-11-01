/** Tag hits in cards and files: keys, caps, and grouping for display. */
import { TAG_SIGIL } from "../constants.js";
import type { TagSource } from "../types.js";

/**
 * Identify the source card or file for distinct counts, regardless of matched tag or line.
 * Use {@link hitRowKey} separately for displayed rows.
 */
export function sourceKey(source: TagSource): string {
  return source.kind === "card"
    ? `card:${source.cardId}`
    : `file:${source.taskspaceId}:${source.path}`;
}

/**
 * Identify one display row per card or per file line. Share this grouping rule between CLI
 * and browser listings.
 */
export function hitRowKey(source: TagSource): string {
  return source.kind === "card"
    ? `card:${source.cardId}`
    : `file:${source.taskspaceId}:${source.path}:${source.line}`;
}

/**
 * Narrow hits by source so filtered arrays expose the corresponding source fields. See {@link
 * groupHitRows}.
 */
export type TagHitOf<T, K extends TagSource["kind"]> = T & {
  source: Extract<TagSource, { kind: K }>;
};

export const isCardHit = <T extends { source: TagSource }>(hit: T): hit is TagHitOf<T, "card"> =>
  hit.source.kind === "card";

export const isFileHit = <T extends { source: TagSource }>(hit: T): hit is TagHitOf<T, "file"> =>
  hit.source.kind === "file";

/** Card and file hits with separate display limits and totals before truncation. */
export interface CappedHits<T extends { source: TagSource }> {
  cards: TagHitOf<T, "card">[];
  files: TagHitOf<T, "file">[];
  /** Totals before display limits, used to explain omitted hits. */
  cardTotal: number;
  fileTotal: number;
}

/**
 * Filter, count, and cap hits in one pass. Keep separate limits for cards and file lines so
 * neither kind excludes the other. Apply optional `keep` filtering before counting and avoid
 * allocating uncapped result arrays.
 */
export function capHitsByKind<T extends { source: TagSource }>(
  hits: T[],
  max: number,
  keep?: (hit: T) => boolean,
): CappedHits<T> {
  const cards: TagHitOf<T, "card">[] = [];
  const files: TagHitOf<T, "file">[] = [];
  let cardTotal = 0;
  let fileTotal = 0;

  for (const hit of hits) {
    if (keep && !keep(hit)) continue;
    if (isCardHit(hit)) {
      cardTotal += 1;
      if (cards.length < max) cards.push(hit);
    } else if (isFileHit(hit)) {
      fileTotal += 1;
      if (files.length < max) files.push(hit);
    }
  }

  return { cards, files, cardTotal, fileTotal };
}

/**
 * Display row with grouped hits and their shared source identity. Use `key` only for row
 * bookkeeping, and read actual card or file identity from `source`.
 */
export interface TagHitRow<T extends { source: TagSource }> {
  /** {@link hitRowKey}. Unique among the rows of one listing, and nothing else. */
  key: string;
  /** The card or file and line that this row opens. */
  source: T["source"];
  hits: T[];
}

/**
 * Group hits by {@link hitRowKey} in first-seen order. Preserve narrowed source types for
 * card-only or file-only inputs.
 */
export function groupHitRows<T extends { source: TagSource }>(hits: T[]): TagHitRow<T>[] {
  const rows = new Map<string, TagHitRow<T>>();
  for (const hit of hits) {
    const key = hitRowKey(hit.source);
    const existing = rows.get(key);
    if (existing) existing.hits.push(hit);
    else rows.set(key, { key, source: hit.source, hits: [hit] });
  }
  return [...rows.values()];
}

/** One taskspace's file rows, under the taskspace they are relative to. */
export interface TaskspaceHitGroup<T extends { source: TagSource }> {
  taskspaceId: string;
  rows: TagHitRow<TagHitOf<T, "file">>[];
}

/**
 * Group file hits by taskspace, then by display row, preserving first-seen order. Taskspace
 * headings distinguish identical relative paths.
 */
export function groupHitsByTaskspace<T extends { source: TagSource }>(
  hits: TagHitOf<T, "file">[],
): TaskspaceHitGroup<T>[] {
  const byTaskspace = new Map<string, TagHitOf<T, "file">[]>();
  for (const hit of hits) {
    const existing = byTaskspace.get(hit.source.taskspaceId);
    if (existing) existing.push(hit);
    else byTaskspace.set(hit.source.taskspaceId, [hit]);
  }
  return [...byTaskspace].map(([taskspaceId, group]) => ({
    taskspaceId,
    rows: groupHitRows(group),
  }));
}

/** Sorted distinct tags matched by a row, including their sigils. */
export function taggedWith(hits: { tag: string }[]): string[] {
  return [...new Set(hits.map(({ tag }) => `${TAG_SIGIL}${tag}`))].sort();
}
