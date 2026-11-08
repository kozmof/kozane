<script lang="ts">
  import { untrack } from "svelte";
  import type { PageProps } from "./$types";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { createAppNavigationDriver } from "./lib/app-navigation.js";
  import { createNodeNavigation, type NavigationAdapter, type NavigationDriver } from "@kozane/client";
  import { createSessionPreferences, type PreferenceStorage } from "@kozane/client";
  import { HttpClient } from "@kozane/client";
  import { StaticClient } from "@kozane/client";
  import { browserPollLifecycle } from "@kozane/client/host";
  import { BoardView } from "@kozane/client/board";

  let { data, navigation = createNodeNavigation({ base, boardTrailingSlash: () => page.url.pathname.endsWith("/") }), routing = createAppNavigationDriver(), preferences = createSessionPreferences() }: PageProps & { navigation?: NavigationAdapter; routing?: NavigationDriver; preferences?: PreferenceStorage } = $props();
  const staticExport = untrack(() => data.staticClientData !== undefined || (data.readonly && !data.clientCapabilities));
  const httpClient = untrack(() => staticExport ? undefined : new HttpClient({ base, fetcher: fetch, pollingInitialDelayMs: 1000, capabilities: data.clientCapabilities ?? { writable: !data.readonly, persistent: true, taskspaces: true, externalWrites: true, auth: false } }));
  const backend = $derived(httpClient ?? new StaticClient(data.staticClientData ?? { namespaces: [data.namespace, ...data.otherNamespaces], snapshots: [data], files: data.taskspaceFiles, warpDirectories: { [data.namespace.id]: data.warpDirectory ?? [] } }));
  const lifecycle = browserPollLifecycle();
</script>

<BoardView
  lifetimeNotice={data.clientLifetimeNotice}
  {data} {backend} {navigation} {routing} {preferences}
  readRouteUrl={() => browser ? page.url : null}
  initialDataApplied={backend.kind !== "static"}
  retryIntervalMs={backend.kind === "static" ? false : undefined}
  lifecycle={backend.kind === "static" ? lifecycle : undefined}
  isHidden={() => document.visibilityState === "hidden"}
/>
