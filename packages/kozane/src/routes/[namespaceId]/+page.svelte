<script lang="ts">
  import type { PageProps } from "./$types";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { createAppNavigationDriver } from "./lib/app-navigation.js";
  import { createNodeNavigation, type NavigationAdapter, type NavigationDriver } from "@kozane/client";
  import { createSessionPreferences, type PreferenceStorage } from "@kozane/client";
  import { useWorkspaceClientSession, selectWorkspaceClient } from "../client-context.js";
  import { browserPollLifecycle } from "@kozane/client/host";
  import { BoardView } from "@kozane/client/board";

  let { data, navigation = createNodeNavigation({ base, boardTrailingSlash: () => page.url.pathname.endsWith("/") }), routing = createAppNavigationDriver(), preferences = createSessionPreferences() }: PageProps & { navigation?: NavigationAdapter; routing?: NavigationDriver; preferences?: PreferenceStorage } = $props();
  const session = useWorkspaceClientSession();
  const client = $derived(selectWorkspaceClient(session, data, () => ({ namespaces: [data.namespace, ...data.otherNamespaces], snapshots: [data], files: data.taskspaceFiles, warpDirectories: { [data.namespace.id]: data.warpDirectory ?? [] } })));
  const lifecycle = browserPollLifecycle();
</script>

<BoardView
  lifetimeNotice={data.clientLifetimeNotice}
  {data} {client} {navigation} {routing} {preferences}
  readRouteUrl={() => browser ? page.url : null}
  initialDataApplied={session.trustsInitialSeed(data)}
  retryIntervalMs={client.kind === "static" ? false : undefined}
  lifecycle={client.kind === "static" ? lifecycle : undefined}
  isHidden={() => document.visibilityState === "hidden"}
/>
