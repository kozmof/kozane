<script lang="ts">
  import type { PageProps } from "./$types";
  import { createNodeNavigation, type NavigationAdapter } from "$lib/navigation.js";
  import { base } from "$app/paths";
  import { untrack } from "svelte";
  import { StaticBackend } from "$lib/backend/static-backend.js";
  import { HttpBackend } from "$lib/backend/http-backend.js";
  import { NamespacesView } from "$lib/client/namespaces/index.js";
  import { css } from "styled-system/css";

  let { data, form, navigation = createNodeNavigation({ base }) }: PageProps & { navigation?: NavigationAdapter } = $props();
  const backend = untrack(() => data.staticBackendData || (data.readonly && !data.backendCapabilities)
    ? new StaticBackend(data.staticBackendData ?? { namespaces: data.namespaces })
    : new HttpBackend({
        base,
        fetcher: fetch,
        pollingInitialDelayMs: 1000,
        capabilities: data.backendCapabilities ?? {
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
  {backend}
  {navigation}
  retryIntervalMs={backend.kind === "static" ? false : undefined}
  initialNamespaces={data.namespaces}
  workspaceName={data.workspaceName}
  workspaceLabel={data.workspaceRoot ?? "Kozane"}
  formError={form?.error}
  emptyState={data.readonly ? readonlyEmptyState : undefined}
/>
