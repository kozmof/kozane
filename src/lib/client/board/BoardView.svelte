<script lang="ts">
  import BoardPage from "./BoardPage.svelte";
  import type { BoardViewProps } from "./types.js";
  let { backend, ...props }: BoardViewProps = $props();
</script>

{#key backend}
  <BoardPage {backend} {...props} />
{/key}
