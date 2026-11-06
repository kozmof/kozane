<script lang="ts">
  import type { PageProps } from "./$types";
  import { untrack } from "svelte";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { createNodeNavigation, type NavigationAdapter } from "$lib/navigation.js";
  import { StaticBackend } from "$lib/backend/static-backend.js";
  import { HttpBackend } from "$lib/backend/http-backend.js";
  import { browserPollLifecycle } from "$lib/backend/workspace-poller.js";
  import { normalizeTag } from "$lib/tag";
  import { TagsView } from "$lib/client/tags/index.js";

  let { data, navigation = createNodeNavigation({ base }) }: PageProps & { navigation?: NavigationAdapter } = $props();
  const httpBackend = untrack(() => data.backendCapabilities
    ? new HttpBackend({ base, fetcher: fetch, capabilities: data.backendCapabilities, pollingInitialDelayMs: 1000 })
    : undefined);
  const backend = $derived(data.staticBackendData ? new StaticBackend(data.staticBackendData) : httpBackend);
  const lifecycle = browserPollLifecycle();
  const selection = $derived.by(() => {
    const filters = browser ? navigation.readFilters(page.url) : { tag: null, namespaceId: null };
    return { tag: data.tag || (filters.tag ? normalizeTag(filters.tag) : null), namespaceId: data.namespaceId ?? filters.namespaceId };
  });
</script>

<TagsView
  lifetimeNotice={data.backendLifetimeNotice}
  {data}
  {selection}
  {navigation}
  {backend}
  retryIntervalMs={backend?.kind === "static" ? false : undefined}
  lifecycle={backend?.kind === "static" ? lifecycle : undefined}
  isHidden={() => document.hidden}
/>
