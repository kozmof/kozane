<script lang="ts">
  import "@kozane/client/styles.css";
  import { verifyCoreIdentity } from "../../verify-core-identity.mjs";
  import { onMount } from "svelte";
  import { beforeNavigate, goto } from "$app/navigation";
  import { createDemoNavigation } from "@kozane/client";
  import { BoardView, TagsView, MapView, EditorSurface, EditorDocument, NamespacesView } from "@kozane/client/ui";
  import { createViewFixture } from "../../view-fixture.js";
  let { data }: { data: { view: string } } = $props();
  let ready = $state(false);
  const navigation = createDemoNavigation({ base: "/kit" });
  const fixture = createViewFixture({
    beforeNavigate: listener => beforeNavigate(listener),
    navigate: url => goto(url),
    replace: url => { void goto(url, { replaceState: true }); },
  });
  const doc = new EditorDocument("Kit editor 日本語");
  onMount(() => { void verifyCoreIdentity().then(() => { ready = true; }); });
</script>

<svelte:head><title>Packed Kit {data.view}</title></svelte:head>
<main data-kit-view={data.view} data-kit-ready={ready}>
  {#if data.view === "board"}
    <BoardView {...fixture.board} {navigation} />
  {:else if data.view === "tags"}
    <TagsView {...fixture.tags} {navigation} />
  {:else if data.view === "map"}
    <MapView {...fixture.map} {navigation} />
  {:else if data.view === "namespaces"}
    <NamespacesView {...fixture.namespaces} {navigation} />
  {:else if data.view === "editor"}
    <EditorSurface {doc} caret={{ line: 0, column: 0 }} anchor={null} />
  {/if}
</main>
