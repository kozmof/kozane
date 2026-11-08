<script lang="ts">
  import { untrack } from "svelte";
  import BoardPage from "./BoardPage.svelte";
  import type { BoardViewProps } from "./types.js";
  let { client, initialDataApplied = false, ...props }: BoardViewProps = $props();
  const initialGeneration = untrack(() => client.version.generation);
  let generation = $state(initialGeneration);
  $effect(() => client.subscribe(event => { generation = event.generation; }));
</script>

{#key generation}
  <BoardPage {client} {...props} initialDataApplied={initialDataApplied && generation === initialGeneration} />
{/key}
