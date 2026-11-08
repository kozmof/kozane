<script lang="ts">
  import Layout from "../routes/+layout.svelte";
  import Probe from "./ClientSessionProbe.svelte";
  import type { ManagedClient } from "@kozane/client";
  let { route, observe }: { route: string; observe: (client: ManagedClient) => void } = $props();
</script>
<Layout>
  {#key route}<Probe label={route} {observe} />{/key}
</Layout>
