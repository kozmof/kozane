<script lang="ts">
  import type { PageProps } from "./$types";
  import { untrack } from "svelte";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { createNodeNavigation, type NavigationAdapter } from "$lib/navigation.js";
  import { StaticBackend } from "../../../packages/client/src/backend/static-backend.js";
  import { HttpBackend } from "../../../packages/client/src/backend/http-backend.js";
  import { browserPollLifecycle } from "../../../packages/client/src/backend/workspace-poller.js";
  import { normalizeTag } from "$lib/tag";
  import { MapView } from "../../../packages/client/src/map/index.js";

  let { data, navigation = createNodeNavigation({ base }) }: PageProps & { navigation?: NavigationAdapter } = $props();
  const httpBackend = untrack(() => data.backendCapabilities
    ? new HttpBackend({ base, fetcher: fetch, capabilities: data.backendCapabilities, pollingInitialDelayMs: 1000 })
    : undefined);
  const backend = $derived(data.staticBackendData ? new StaticBackend(data.staticBackendData) : httpBackend);
  const lifecycle = browserPollLifecycle();
  const selection = $derived.by(() => {
    const filters = browser ? navigation.readFilters(page.url) : { namespaceId: null, tag: null, day: null };
    return { namespaceId: data.namespaceId ?? filters.namespaceId, tag: data.tag || (filters.tag ? normalizeTag(filters.tag) : null), day: data.day ?? filters.day };
  });
</script>

<MapView
  lifetimeNotice={data.backendLifetimeNotice}
  {data}
  {selection}
  {navigation}
  {backend}
  retryIntervalMs={backend?.kind === "static" ? false : undefined}
  lifecycle={backend?.kind === "static" ? lifecycle : undefined}
  isHidden={() => document.hidden}
/>
