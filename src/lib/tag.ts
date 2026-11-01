/**
 * Use one tag grammar for card text, taskspace files, the CLI, and the browser. This module has
 * no database or filesystem dependencies. It also supplies the shared grouping and display
 * helpers.
 *
 * A tag starts with `:` at the start of text, after whitespace, or after an opening `(`, `[`,
 * or `{`. Each segment contains Unicode letters, numbers, underscores, or hyphens. Colons
 * separate levels, so `:foo:bar:baz` has the body `foo:bar:baz`.
 *
 * Ordinary punctuation such as `12:30` and `key: value` does not open a tag. URL spans are
 * excluded before scanning, using `lib/urls.ts`, so a tag cannot start inside or continue into
 * a URL. The index and renderer use this same boundary rule.
 *
 * A trailing colon does not cancel a tag. `:foo:` contains the tag `foo` followed by
 * punctuation.
 *
 * The grammar applies uniformly to every source. Symbol literals such as `:active` and
 * emoticons such as `:D` can therefore become tags. The file scanner skips generated and
 * dependency directories listed in `TAG_SCAN_SKIP_DIRS`, but does not apply language-specific
 * exclusions to handwritten source.
 *
 * The code is split by topic under `./tag/`. Import from this module.
 */
export { normalizeTag, splitTag, tagMatches, tagMatcher } from "./tag/syntax.js";
export { type TagPosition, scanTagPositions, type TagLineHit, scanTagLines } from "./tag/scan.js";
export {
  sourceKey,
  hitRowKey,
  type TagHitOf,
  isCardHit,
  isFileHit,
  type CappedHits,
  capHitsByKind,
  type TagHitRow,
  groupHitRows,
  type TaskspaceHitGroup,
  groupHitsByTaskspace,
  taggedWith,
} from "./tag/hits.js";
export { type TagCounts, type TagNode, buildTagTree } from "./tag/tree.js";
export {
  truncationReasons,
  CARDS_TRUNCATED_LABEL,
  missingTaskspaceLabel,
  TASKSPACE_CLEANUP_COMMAND,
  cleanupCommandTail,
  truncationPaths,
} from "./tag/truncation.js";
