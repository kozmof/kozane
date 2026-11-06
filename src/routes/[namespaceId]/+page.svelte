<script lang="ts">
  import { untrack } from "svelte";
  import type { PageProps } from "./$types";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { createAppNavigationDriver } from "./lib/app-navigation.js";
  import { createNodeNavigation, type NavigationAdapter, type NavigationDriver } from "$lib/navigation.js";
  import { createSessionPreferences, type PreferenceStorage } from "$lib/preferences.js";
  import { HttpBackend } from "$lib/backend/http-backend.js";
  import { StaticBackend } from "$lib/backend/static-backend.js";
  import { browserPollLifecycle } from "$lib/backend/workspace-poller.js";
  import { BoardView } from "$lib/client/board/index.js";

  let { data, navigation = createNodeNavigation({ base, boardTrailingSlash: () => page.url.pathname.endsWith("/") }), routing = createAppNavigationDriver(), preferences = createSessionPreferences() }: PageProps & { navigation?: NavigationAdapter; routing?: NavigationDriver; preferences?: PreferenceStorage } = $props();
  const staticExport = untrack(() => data.staticBackendData !== undefined || (data.readonly && !data.backendCapabilities));
  const httpBackend = untrack(() => staticExport ? undefined : new HttpBackend({ base, fetcher: fetch, pollingInitialDelayMs: 1000, capabilities: data.backendCapabilities ?? { writable: !data.readonly, persistent: true, taskspaces: true, externalWrites: true, auth: false } }));
  const backend = $derived(httpBackend ?? new StaticBackend(data.staticBackendData ?? { namespaces: [data.namespace, ...data.otherNamespaces], snapshots: [data], files: data.taskspaceFiles, warpDirectories: { [data.namespace.id]: data.warpDirectory ?? [] } }));
  const lifecycle = browserPollLifecycle();
</script>

<BoardView
  lifetimeNotice={data.backendLifetimeNotice}
  {data} {backend} {navigation} {routing} {preferences}
  readRouteUrl={() => browser ? page.url : null}
  initialDataApplied={backend.kind !== "static"}
  retryIntervalMs={backend.kind === "static" ? false : undefined}
  lifecycle={backend.kind === "static" ? lifecycle : undefined}
  isHidden={() => document.visibilityState === "hidden"}
/>
