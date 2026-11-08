<script lang="ts">
  import type { PageProps } from "./$types";
  import { createNodeNavigation, type NavigationAdapter } from "@kozane/client";
  import { base } from "$app/paths";
  import { untrack } from "svelte";
  import { StaticClient } from "@kozane/client";
  import { HttpClient } from "@kozane/client";
  import { NamespacesView } from "@kozane/client/ui";
  import { css } from "styled-system/css";

  let { data, form, navigation = createNodeNavigation({ base }) }: PageProps & { navigation?: NavigationAdapter } = $props();
  const backend = untrack(() => data.staticClientData || (data.readonly && !data.clientCapabilities)
    ? new StaticClient(data.staticClientData ?? { namespaces: data.namespaces })
    : new HttpClient({
        base,
        fetcher: fetch,
        pollingInitialDelayMs: 1000,
        capabilities: data.clientCapabilities ?? {
          writable: !data.readonly, persistent: true, externalWrites: true, taskspaces: true, auth: false,
        },
      }));
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
  {backend}
  {navigation}
  retryIntervalMs={backend.kind === "static" ? false : undefined}
  initialNamespaces={data.namespaces}
  workspaceName={data.workspaceName}
  workspaceLabel={data.workspaceRoot ?? "Kozane"}
  formError={form?.error}
  emptyState={data.readonly ? readonlyEmptyState : undefined}
/>
