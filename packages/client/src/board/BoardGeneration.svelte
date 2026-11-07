<script lang="ts">
  import { untrack } from "svelte";
  import BoardPage from "./BoardPage.svelte";
  import type { BoardViewProps } from "./types.js";
  let { backend, initialDataApplied = false, ...props }: BoardViewProps = $props();
  const initialGeneration = untrack(() => backend.version.generation);
  let generation = $state(initialGeneration);
  $effect(() => backend.subscribe(event => { generation = event.generation; }));
</script>

{#key generation}
  <BoardPage {backend} {...props} initialDataApplied={initialDataApplied && generation === initialGeneration} />
{/key}
