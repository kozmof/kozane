<script lang="ts">
  import type { PageProps } from "./$types";
  import { createNodeNavigation, type NavigationAdapter } from "@kozane/client";
  import { base } from "$app/paths";
  import { useWorkspaceClientSession, selectWorkspaceClient } from "./client-context.js";
  import { NamespacesView } from "@kozane/client/ui";
  import { css } from "styled-system/css";

  let { data, form, navigation = createNodeNavigation({ base }) }: PageProps & { navigation?: NavigationAdapter } = $props();
  const session = useWorkspaceClientSession();
  const client = $derived(selectWorkspaceClient(session, data, () => ({ namespaces: data.namespaces })));
</script>

{#snippet readonlyEmptyState()}
  No namespaces yet. Run
  <code class={css({ fontFamily: "mono", fontSize: "12px", backgroundColor: "neutral.bg", padding: "2px 6px", borderRadius: "2px" })}>
    kozane namespace create &lt;name&gt;
  </code>
  to create one.
{/snippet}

<NamespacesView
  lifetimeNotice={data.clientLifetimeNotice}
  {client}
  {navigation}
  retryIntervalMs={client.kind === "static" ? false : undefined}
  initialNamespaces={data.namespaces}
  workspaceName={data.workspaceName}
  workspaceLabel={data.workspaceRoot ?? "Kozane"}
  formError={form?.error}
  emptyState={data.readonly ? readonlyEmptyState : undefined}
/>
