<script lang="ts">
  import { css } from "styled-system/css";
  import type { MapLayout } from "../lib/map-layout.js";

  /**
   * The same map in words, for a reader who cannot see it. An `<svg>` with one label says what
   * the picture is about and nothing about what is in it, and every number on the page is in
   * the picture.
   */
  let { layout }: { layout: MapLayout } = $props();

  const cardCount = (cards: number) => `${cards} card${cards === 1 ? "" : "s"}`;
</script>

<div class={css({ srOnly: true })}>
  <h2>What the map shows</h2>
  <ul>
    {#each layout.namespaces as namespace (namespace.id)}
      <li>
        {namespace.name}: {cardCount(namespace.cards)}
        <ul>
          {#each layout.partitions.filter((b) => b.partition.namespaceId === namespace.id) as placed (placed.partition.id)}
            <li>{placed.partition.name}: {cardCount(placed.partition.cards)}</li>
          {/each}
        </ul>
      </li>
    {/each}
  </ul>
  {#if layout.scopes.length > 0}
    <h2>Scopes across the map</h2>
    <ul>
      {#each layout.scopes as scope (scope.id)}
        <li>{scope.name}: reaches {scope.spokes.length} of them</li>
      {/each}
    </ul>
  {/if}
</div>
