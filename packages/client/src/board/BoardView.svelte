<script lang="ts">
  import BoardGeneration from "./BoardGeneration.svelte";
  import type { BoardViewProps } from "./types.js";
  let { client, ...props }: BoardViewProps = $props();
</script>

{#key client}
  <BoardGeneration {client} {...props} />
{/key}
