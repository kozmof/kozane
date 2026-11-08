<script lang="ts">
  import { untrack } from "svelte";
  import { useWorkspaceClientSession } from "../routes/client-context.js";
  import type { ManagedClient } from "@kozane/client";
  let { label, observe }: { label: string; observe: (client: ManagedClient) => void } = $props();
  const session = useWorkspaceClientSession();
  const client = session.select({ clientCapabilities: { writable: true, persistent: true, externalWrites: true, taskspaces: true, auth: false } })!;
  untrack(() => observe(client));
</script>
<p>{label}</p>
