<script lang="ts">
  import type { Snippet } from "svelte";
  import { css } from "styled-system/css";
  import { taggedWith, type TagHitOf, type TagHitRow, type TaskspaceHitGroup } from "$lib/tag";
  import type { TagHit } from "$lib/types";
  import type { TagsPageData } from "./types.js";
  import {
    cardRowClass,
    excerptClass,
    fileRowClass,
    linkableRowClass,
    taskspaceHeadingClass,
  } from "./styles.js";

  /** The cards and files a selected tag gathers, with the notice when the list is capped. */
  let {
    data,
    selectedTag,
    selectedNamespaceId,
    shownCount,
    cappedNotice,
    cardRows,
    fileRowsByTaskspace,
    namespaceName,
    taskspaceName,
    cardHref,
    fileHref,
  }: {
    data: Pick<TagsPageData, "cardPartitionIds" | "partitions" | "cardNamespaces">;
    selectedTag: string;
    selectedNamespaceId: string | null;
    shownCount: number;
    cappedNotice: string | null;
    cardRows: TagHitRow<TagHitOf<TagHit, "card">>[];
    fileRowsByTaskspace: TaskspaceHitGroup<TagHit>[];
    namespaceName: (id: string | null | undefined) => string;
    taskspaceName: (id: string) => string;
    /** Null when the card's board is not in this export. */
    cardHref: (cardId: string) => string | null;
    fileHref: (taskspaceId: string, path: string) => string | null;
  } = $props();
</script>

{#snippet hitRow(href: string | null, shape: string, body: Snippet)}
  {#if href}
    <a {href} class="{shape} {linkableRowClass}">{@render body()}</a>
  {:else}
    <!-- Show the result without link behavior when no destination board exists. -->
    <div class={shape}>{@render body()}</div>
  {/if}
{/snippet}

<h2 class={css({ fontSize: "15px", fontFamily: "mono", marginBottom: "16px" })}>
  '{selectedTag}
</h2>

{#if shownCount === 0}
  <p class={css({ color: "neutral.subtle", fontSize: "13px" })}>Nothing under this tag.</p>
{:else if cappedNotice}
  <p
    class={css({ color: "neutral.subtle", fontSize: "12px", marginBottom: "12px" })}
  >
    {cappedNotice}
  </p>
{/if}

{#if cardRows.length > 0}
  <ul
    class={css({
      listStyle: "none",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      marginBottom: "28px",
    })}
  >
    {#each cardRows as { key, source, hits } (key)}
      {@const cardId = source.cardId}
      <!-- Guard both optional lookups before reading partition metadata. -->
      {@const partitionId = data.cardPartitionIds[cardId]}
      {@const partition = partitionId ? data.partitions[partitionId] : undefined}
      <li>
        {#snippet cardBody()}
          <span class={excerptClass}>{hits[0].excerpt}</span>
          <span
            class={css({
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginTop: "8px",
              fontSize: "11px",
              color: "neutral.subtle",
            })}
          >
            {#if partition}
              <span
                style="background: {partition.dot}"
                class={css({ width: "8px", height: "8px", borderRadius: "999px" })}
              ></span>
              {partition.name}
            {/if}
            <!-- Identify each card's board in workspace-wide results. -->
            {#if !selectedNamespaceId}
              <span>{namespaceName(data.cardNamespaces[cardId])}</span>
            {/if}
            <span class={css({ fontFamily: "mono" })}>{taggedWith(hits).join(" ")}</span>
          </span>
        {/snippet}
        {@render hitRow(cardHref(cardId), cardRowClass, cardBody)}
      </li>
    {/each}
  </ul>
{/if}

{#each fileRowsByTaskspace as { taskspaceId, rows } (taskspaceId)}
  <!-- Show the taskspace name to distinguish identical relative paths in different taskspaces. -->
  <h3 class={taskspaceHeadingClass}>{taskspaceName(taskspaceId)}</h3>
  <ul
    class={css({
      listStyle: "none",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      marginBottom: "28px",
    })}
  >
    {#each rows as { key, source, hits } (key)}
      <li>
        {#snippet fileBody()}
          <span
            class={css({
              fontFamily: "mono",
              fontSize: "11.5px",
              color: "neutral.muted",
              flexShrink: "0",
            })}
          >
            {source.path}:{source.line}
          </span>
          <span class={excerptClass}>{hits[0].excerpt}</span>
        {/snippet}
        {@render hitRow(fileHref(taskspaceId, source.path), fileRowClass, fileBody)}
      </li>
    {/each}
  </ul>
{/each}
