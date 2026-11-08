<script lang="ts">
  import RefreshNotice from "../RefreshNotice.svelte";
  import ClientNotice from "../ClientNotice.svelte";
  import type { NavigationAdapter } from "../navigation.js";
  import type { MapViewClient } from "../client/view-clients.js";
  import type { PollLifecycle } from "../client/workspace-poller.js";
  import type { MapPageData, MapSelection } from "./types.js";
  import { untrack } from "svelte";
  import { startDatasetView } from "../client/dataset-view.js";
  import { mapView, type MapViewData } from "../client/views/map.js";
  import { css } from "../styles/css.js";
  import { buildTagTree, normalizeTag } from "../tag/index.js";
  import NavIcon from "../components/NavIcon.svelte";
  import TagPanel from "./components/TagPanel.svelte";
  import MapZoomControl from "./components/MapZoomControl.svelte";
  import ActivityStrip from "./components/ActivityStrip.svelte";
  import MapDescription from "./components/MapDescription.svelte";
  import MapDrawing from "./components/MapDrawing.svelte";
  import { DRAG_THRESHOLD, MAP_DEFAULT_VIEWPORT } from "../constants/index.js";
  import {
    buildMapLayout,
    tagLinks,
  } from "./lib/map-layout.js";
  import {
    clampView,
    defaultView,
    pannedBy,
    viewedArea,
    zoomedBy,
    zoomedTo,
    isDefaultView,
    type MapView as MapViewport,
  } from "./lib/view.js";
  import { tagPartitionIndex, tagPartitionTargets } from "./lib/graph.js";
  import { tagLineOrigin, visibleTagRows, MAP_HEADER_HEIGHT } from "./lib/tag-rows.js";
  import {
    activityCells,
    activityRangeLabel,
    partitionsForDay,
    tagHitsForDay,
  } from "./lib/activity.js";

  /**
   * Display workspace structure through namespace and partition areas, scope links, and tags.
   * Interactions navigate or change the view without writing workspace data.
   */

  let { data, selection, navigation, backend, lifetimeNotice, retryIntervalMs, lifecycle, isHidden = () => false }: {
    data: MapPageData;
    selection: MapSelection;
    navigation: NavigationAdapter;
    backend?: MapViewClient;
    lifetimeNotice?: string;
    retryIntervalMs?: number | false;
    lifecycle?: Pick<PollLifecycle, "listen">;
    isHidden?: () => boolean;
  } = $props();
  const selectedTag = $derived(selection.tag ? normalizeTag(selection.tag) : null);
  const selectedNamespaceId = $derived(selection.namespaceId);
  const selectedDay = $derived(selection.day);
  const source = $derived({ data, backend, namespaceId: selectedNamespaceId, tag: selectedTag, day: selectedDay });
  let refreshed = $state.raw<{ source: typeof source; value: MapViewData } | null>(null);
  let refreshAttempt = $state(0);
  let failedSource = $state.raw<typeof source | null>(null);
  const refreshFailed = $derived(failedSource === source);
  const display = $derived(refreshed?.source === source ? { ...data, ...refreshed.value } : data);
  $effect(() => {
    const currentSource = source;
    const attempt = refreshAttempt;
    const current = currentSource.backend;
    const interval = retryIntervalMs;
    const wake = lifecycle;
    const hidden = isHidden;
    if (!current) return;
    return untrack(() => startDatasetView({
      backend: current,
      retryIntervalMs: interval,
      lifecycle: wake,
      dataset: "map",
      read: async (_isCurrent, options) => mapView(await current.map.get(options), { namespaceId: currentSource.namespaceId, tag: currentSource.tag, day: currentSource.day, zoomStep: currentSource.data.zoomStep }),
      apply: (value) => { if (attempt !== refreshAttempt) return; refreshed = { source: currentSource, value }; failedSource = null; },
      error: () => { if (attempt === refreshAttempt) failedSource = currentSource; },
      isHidden: hidden,
    }));
  });
  const selectedNamespace = $derived(display.namespaces.find(({ id }) => id === selectedNamespaceId) ?? null);

  // Keep day filtering of partition sizes and tag hits aligned. See `partitionsForDay`.
  const displayedPartitions = $derived(partitionsForDay(display.partitions, display.activity, selectedDay));
  const displayedTagHits = $derived(tagHitsForDay(display.tagHits, display.tagCards, selectedDay));
  const tree = $derived(buildTagTree(displayedTagHits));
  const mapTags = $derived(tagPartitionIndex(displayedTagHits, display.tagCards));

  const heatmap = $derived(
    activityCells(
      display.activity.map(({ day, cards }) => ({ day, cards })),
    ),
  );
  const activityRange = $derived(activityRangeLabel(heatmap));

  /**
   * Use measured viewport dimensions in the browser and {@link MAP_DEFAULT_VIEWPORT} during
   * server rendering. Render a complete map before hydration, then recompute it at the real
   * size.
   */
  let measuredWidth = $state(0);
  let measuredHeight = $state(0);
  const size = $derived(
    measuredWidth > 0 && measuredHeight > 0
      ? { width: measuredWidth, height: measuredHeight }
      : MAP_DEFAULT_VIEWPORT,
  );

  /**
   * Store raw view state and derive a clamped view for current dimensions. Null uses the
   * centered opening view so resizing before user interaction does not retain server-sized
   * offsets.
   */
  let movedView = $state<MapViewport | null>(null);
  const rawView = $derived(movedView ?? defaultView(size));
  const view = $derived(clampView(rawView, size));
  const atDefault = $derived(isDefaultView(view, size));

  /**
   * Lay out the map within the view rectangle so zoom changes areas while labels and gaps
   * retain their pixel sizes.
   */
  const layout = $derived(
    buildMapLayout({
      namespaces: display.drawn,
      partitions: displayedPartitions,
      scopes: display.scopes,
      area: viewedArea(size, view),
    }),
  );

  /**
   * Allow panning from any map point, including linked partitions. Suppress the following
   * click when movement crosses the drag threshold.
   */
  // Share the board's distance threshold but use Manhattan distance here. This makes diagonal
  // movement suppress accidental link activation slightly sooner.
  let dragging = $state(false);
  let travelled = false;
  let origin: { x: number; y: number; view: MapViewport } | null = null;

  function onPointerDown(event: PointerEvent) {
    // Handle only the primary button. Preserve the context menu and browser middle-button
    // scrolling.
    if (event.button !== 0) return;
    origin = { x: event.clientX, y: event.clientY, view };
    dragging = true;
    // Reset click suppression on the next press because releasing outside the map may produce
    // no click.
    travelled = false;
  }

  function onPointerMove(event: PointerEvent) {
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    // Capture only after dragging starts so ordinary clicks still reach partition links.
    // Pointer capture redirects the click to the capturing element.
    if (!travelled && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      travelled = true;
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }
    // From where the drag began and how far the pointer has gone altogether, not from the
    // last frame. See `pannedBy`.
    movedView = pannedBy(origin.view, size, dx, dy);
  }

  function onPointerUp(event: PointerEvent) {
    origin = null;
    dragging = false;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  }

  /** Suppress the click after a drag during capture so a partition link cannot open its board. */
  function onClickCapture(event: MouseEvent) {
    if (!travelled) return;
    event.preventDefault();
    event.stopPropagation();
    travelled = false;
  }

  /**
   * Zoom toward the pointer with Ctrl/Cmd and the wheel. Register a non-passive listener so
   * preventing default can stop browser page zoom. Leave unmodified wheel input alone.
   */
  let mapEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const el = mapEl;
    if (!el) return;
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = el!.getBoundingClientRect();
      const at = { x: event.clientX - box.left, y: event.clientY - box.top };
      const delta = event.deltaY < 0 ? display.zoomStep : -display.zoomStep;
      movedView = zoomedTo(view, size, at, view.zoom + delta);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  /**
   * Partitions reached by the selected tag and its descendants. Return no targets when no tag
   * is selected.
   */
  const targets = $derived(
    selectedTag ? tagPartitionTargets(mapTags.index, selectedTag) : new Map(),
  );

  /**
   * Compute tag-row positions from tree layout so links render correctly before hydration.
   * Adjust by panel scroll after user interaction.
   */
  const rows = $derived(visibleTagRows(tree, selectedTag));
  let panelScroll = $state(0);
  const lineOrigin = $derived(tagLineOrigin(rows, selectedTag, panelScroll));

  const links = $derived(lineOrigin === null ? [] : tagLinks(layout, lineOrigin, targets));
  /** Dim the packing only when the selected tag has graph targets. */
  const dimming = $derived(links.length > 0);

  // Change one map filter while preserving the other two.
  const current = $derived({ namespaceId: selectedNamespaceId, tag: selectedTag, day: selectedDay });
  const tagHref = (tag: string | null) => navigation.map({ ...current, tag });
  const namespaceHref = (namespaceId: string | null) => navigation.map({ ...current, namespaceId });
  const dayHref = (day: string | null) => navigation.map({ ...current, day });

  /**
   * Keep partitions fully opaque unless an active tag reaches other partitions but not this
   * one.
   */
  const lit = (partitionId: string) => !dimming || targets.has(partitionId);


  /**
   * Use dim navigation icons with enlarged hit targets so they remain separate from the map
   * and easy to activate.
   */
  const headerLinkClass = css({
    display: "flex",
    alignItems: "center",
    // The gap separates the icon and label and takes no space when the link has only an icon.
    gap: "6px",
    padding: "6px",
    borderRadius: "2px",
    // A label's weight for the name beside the picture, an icon's for the picture. Both
    // darken together on hover, or half the link would light up.
    color: "neutral.iconDim",
    textDecoration: "none",
    "& span": { color: "neutral.muted" },
    _hover: {
      color: "ink.black",
      backgroundColor: "neutral.border",
      "& span": { color: "ink.black" },
    },
  });
</script>

<svelte:head>
  <title>{selectedNamespace ? `Map · ${selectedNamespace.name}` : "Map"}</title>
</svelte:head>

<!-- Fill the fixed-height viewport with the map and overlay controls. Hide page overflow so panning is the single way to move the map and graph coordinates remain aligned. -->
{#if backend}<ClientNotice capabilities={backend.capabilities} {lifetimeNotice} floating />{/if}
<RefreshNotice {backend} failed={refreshFailed} message="Could not refresh map. Showing the last map." retry={() => refreshAttempt++} floating />

<main
  class={css({
    position: "relative",
    height: "100dvh",
    overflow: "hidden",
    backgroundColor: "ink.lighter",
  })}
>
  <!-- Allow map dragging through gaps in the header band. Enable pointer events on the links themselves. -->
  <header
    style="height: {MAP_HEADER_HEIGHT}px"
    class={css({
      position: "absolute",
      top: "0",
      left: "0",
      right: "0",
      zIndex: "2",
      boxSizing: "border-box",
      padding: "0 16px",
      display: "flex",
      alignItems: "center",
      gap: "6px 14px",
      fontSize: "12px",
      fontFamily: "mono",
      pointerEvents: "none",
      "& a": { pointerEvents: "auto" },
    })}
  >
    <!-- Link back to the namespace list or selected namespace board. Label the destination explicitly because the icon alone cannot distinguish them. -->
    <a
      href={selectedNamespaceId ? navigation.board(selectedNamespaceId) : navigation.namespaces()}
      title={selectedNamespace ? undefined : "Namespaces"}
      aria-label={selectedNamespace ? `Back to ${selectedNamespace.name}` : "All namespaces"}
      class={headerLinkClass}
    >
      <NavIcon kind="namespaces" />
      {#if selectedNamespace}
        <span>{selectedNamespace.name}</span>
      {/if}
    </a>
    <a href={navigation.tags()} title="Tags" aria-label="Tags" class={headerLinkClass}>
      <NavIcon kind="tags" />
    </a>

    <!-- Which namespace the map is narrowed to, and the way to change it. Picking the namespace
         already selected clears the narrowing, which is the way back to the whole workspace.
         The same control the tag index carries, in the same place. -->
    <nav
      aria-label="Namespace"
      class={css({
        display: "flex",
        gap: "10px",
        marginLeft: "auto",
        // Scroll sideways rather than wrap onto a second line. See `MAP_HEADER_HEIGHT`. A workspace
        // of thirty namespaces scrolls its list instead of taking a second band off the map.
        overflowX: "auto",
        whiteSpace: "nowrap",
        scrollbarWidth: "none",
      })}
    >
      {#each display.namespaces as namespace (namespace.id)}
        {@const selected = selectedNamespaceId === namespace.id}
        <a
          href={namespaceHref(selected ? null : namespace.id)}
          aria-current={selected ? "page" : undefined}
          class={css({
            textDecoration: "none",
            color: "neutral.subtle",
            _hover: { color: "ink.black" },
          })}
          style={selected ? "color: var(--colors-ink-black); font-weight: 600" : ""}
        >
          {namespace.name}
        </a>
      {/each}
    </nav>
  </header>

  {#if display.drawn.length !== 0}
    {#if tree.length !== 0}
      <TagPanel
        {tree}
        {selectedTag}
        cardsTruncated={display.cardsTruncated ?? false}
        {tagHref}
        onScroll={(scrollTop) => (panelScroll = scrollTop)}
      />
    {/if}

      <!-- Capture pointer input for map panning and disable native touch scrolling. Keep the surface presentational, expose the map through its text, and provide keyboard-accessible zoom buttons. -->
      <div
        bind:this={mapEl}
        bind:clientWidth={measuredWidth}
        bind:clientHeight={measuredHeight}
        role="presentation"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onclickcapture={onClickCapture}
        class={css({
          position: "absolute",
          inset: "0",
          // Zoomed in, the packing is larger than the window. Clip it to the window rather than
          // drawing past the edges. It is the bottom of the stack, so the header and the
          // panel are over it rather than under.
          overflow: "hidden",
          touchAction: "none",
          cursor: dragging ? "grabbing" : "grab",
        })}
      >
        <MapDrawing
          boardHref={(namespaceId) => navigation.board(namespaceId)}
          {layout} {links} {size} {selectedDay} {lit}
        />

        <MapZoomControl
          zoom={view.zoom}
          zoomStep={display.zoomStep}
          {atDefault}
          onZoomBy={(delta) => (movedView = zoomedBy(view, size, delta))}
          onReset={() => (movedView = null)}
        />
      </div>

      <ActivityStrip cells={heatmap} {selectedDay} rangeLabel={activityRange} {dayHref} />

    <MapDescription {layout} />
  {/if}
</main>
