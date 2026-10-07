<script lang="ts">
  import { css } from "styled-system/css";
  import { CARDS_TRUNCATED_LABEL, type TagNode } from "$lib/tag";
  import {
    childrenShown,
    TAG_PANEL_LEFT,
    TAG_PANEL_TOP,
    TAG_PANEL_WIDTH,
    TAG_ROW_HEIGHT,
  } from "../lib/tag-rows.js";

  /**
   * Place the scrollable tag panel at the shared graph origin and report scroll offsets for
   * link positioning. Avoid top padding and borders because row coordinates begin at this
   * edge.
   */
  let {
    tree,
    selectedTag,
    cardsTruncated,
    tagHref,
    onScroll,
  }: {
    tree: TagNode[];
    selectedTag: string | null;
    cardsTruncated: boolean;
    /** The map with `tag` drawn, or with none for null. */
    tagHref: (tag: string | null) => string;
    onScroll: (scrollTop: number) => void;
  } = $props();

  /** Show only card totals because the map does not gather file tags. */
  const countLabel = (node: TagNode) => `${node.total.cards}`;
  const countDescription = (node: TagNode) =>
    `${node.total.cards} card${node.total.cards === 1 ? "" : "s"}`;

  /**
   * Set row height with inline style. Panda cannot extract a rule from a runtime-interpolated
   * constant, and tag-line geometry depends on this exact height.
   */
  const rowStyle = `height: ${TAG_ROW_HEIGHT}px`;

  /**
   * Pinned to `TAG_ROW_HEIGHT` rather than left to come out of the font, because
   * `tagRowCenter` multiplies by it to decide where a tag's lines leave from. A row an odd
   * pixel taller than the constant would put every line below it out by a growing amount.
   */
  const rowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "0 8px",
    borderRadius: "2px",
    color: "ink.black",
    textDecoration: "none",
    fontSize: "13px",
    _hover: { backgroundColor: "neutral.bg" },
  });
  const activeRowClass = css({ backgroundColor: "neutral.bg", fontWeight: "600" });
  const countClass = css({ fontSize: "10.5px", color: "neutral.subtle", fontFamily: "mono" });
</script>

{#snippet branch(nodes: TagNode[], depth: number)}
  <ul class={css({ listStyle: "none", margin: "0", padding: "0" })}>
    {#each nodes as node (node.tag)}
      <li>
        <a
          href={tagHref(selectedTag === node.tag ? null : node.tag)}
          aria-current={selectedTag === node.tag ? "page" : undefined}
          style="{rowStyle}; padding-left: {8 + depth * 14}px"
          class="{rowClass} {selectedTag === node.tag ? activeRowClass : ''}"
        >
          <span class={css({ fontFamily: "mono" })}>{node.name}</span>
          <!-- Bare in the column, spelled out for a reader who cannot see the column. The
               same split the tag index makes. -->
          <span class={countClass} aria-hidden="true">{countLabel(node)}</span>
          <span class={css({ srOnly: true })}>{countDescription(node)}</span>
        </a>
        {#if childrenShown(node, depth, selectedTag)}
          {@render branch(node.children, depth + 1)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<nav
  aria-label="Tags"
  onscroll={(event) => onScroll(event.currentTarget.scrollTop)}
  style="left: {TAG_PANEL_LEFT}px; top: {TAG_PANEL_TOP}px; width: {TAG_PANEL_WIDTH}px; max-height: calc(100% - {TAG_PANEL_TOP + 16}px)"
  class={css({
    position: "absolute",
    zIndex: "1",
    boxSizing: "border-box",
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: "0 4px",
    scrollbarWidth: "thin",
  })}
>
  {@render branch(tree, 0)}
  {#if cardsTruncated}
    <p
      class={css({
        fontSize: "11px",
        color: "neutral.subtle",
        padding: "8px",
        maxWidth: "34ch",
      })}
    >
      {CARDS_TRUNCATED_LABEL}
    </p>
  {/if}
</nav>
