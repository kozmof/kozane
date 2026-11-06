<script lang="ts">
  import BoardGeneration from "./BoardGeneration.svelte";
  import type { BoardViewProps } from "./types.js";
  let { backend, ...props }: BoardViewProps = $props();
</script>

{#key backend}
  <BoardGeneration {backend} {...props} />
{/key}
