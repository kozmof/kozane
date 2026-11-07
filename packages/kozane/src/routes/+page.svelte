<script lang="ts">
  import type { PageProps } from "./$types";
  import { createNodeNavigation, type NavigationAdapter } from "../../../client/src/navigation.js";
  import { base } from "$app/paths";
  import { untrack } from "svelte";
  import { StaticBackend } from "../../../client/src/backend/static-backend.js";
  import { HttpBackend } from "../../../client/src/backend/http-backend.js";
  import { NamespacesView } from "../../../client/src/namespaces/index.js";
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
  lifetimeNotice={data.backendLifetimeNotice}
  {backend}
  {navigation}
  retryIntervalMs={backend.kind === "static" ? false : undefined}
  initialNamespaces={data.namespaces}
  workspaceName={data.workspaceName}
  workspaceLabel={data.workspaceRoot ?? "Kozane"}
  formError={form?.error}
  emptyState={data.readonly ? readonlyEmptyState : undefined}
/>
