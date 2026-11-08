<script lang="ts">
  import type { PageProps } from "./$types";
  import { untrack } from "svelte";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { createNodeNavigation, type NavigationAdapter } from "@kozane/client";
  import { StaticClient } from "@kozane/client";
  import { HttpClient } from "@kozane/client";
  import { browserPollLifecycle } from "@kozane/client/host";
  import { normalizeTag } from "$lib/tag";
  import { TagsView } from "@kozane/client/tags";

  let { data, navigation = createNodeNavigation({ base }) }: PageProps & { navigation?: NavigationAdapter } = $props();
  const httpClient = untrack(() => data.clientCapabilities
    ? new HttpClient({ base, fetcher: fetch, capabilities: data.clientCapabilities, pollingInitialDelayMs: 1000 })
    : undefined);
  const backend = $derived(data.staticClientData ? new StaticClient(data.staticClientData) : httpClient);
  const lifecycle = browserPollLifecycle();
  const selection = $derived.by(() => {
    const filters = browser ? navigation.readFilters(page.url) : { tag: null, namespaceId: null };
    return { tag: data.tag || (filters.tag ? normalizeTag(filters.tag) : null), namespaceId: data.namespaceId ?? filters.namespaceId };
  });
</script>

<TagsView
  lifetimeNotice={data.clientLifetimeNotice}
  {data}
  {selection}
  {navigation}
  {backend}
  retryIntervalMs={backend?.kind === "static" ? false : undefined}
  lifecycle={backend?.kind === "static" ? lifecycle : undefined}
  isHidden={() => document.hidden}
/>
