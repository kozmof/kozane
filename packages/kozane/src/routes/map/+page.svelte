<script lang="ts">
  import type { PageProps } from "./$types";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { createNodeNavigation, type NavigationAdapter } from "@kozane/client";
  import { useWorkspaceClientSession, selectWorkspaceClient } from "../client-context.js";
  import { browserPollLifecycle } from "@kozane/client/host";
  import { normalizeTag } from "$lib/tag";
  import { MapView } from "@kozane/client/map";

  let { data, navigation = createNodeNavigation({ base }) }: PageProps & { navigation?: NavigationAdapter } = $props();
  const session = useWorkspaceClientSession();
  const backend = $derived(selectWorkspaceClient(session, data));
  const lifecycle = browserPollLifecycle();
  const selection = $derived.by(() => {
    const filters = browser ? navigation.readFilters(page.url) : { namespaceId: null, tag: null, day: null };
    return { namespaceId: data.namespaceId ?? filters.namespaceId, tag: data.tag || (filters.tag ? normalizeTag(filters.tag) : null), day: data.day ?? filters.day };
  });
</script>

<MapView
  lifetimeNotice={data.clientLifetimeNotice}
  {data}
  {selection}
  {navigation}
  {backend}
  retryIntervalMs={backend?.kind === "static" ? false : undefined}
  lifecycle={backend?.kind === "static" ? lifecycle : undefined}
  isHidden={() => document.hidden}
/>
