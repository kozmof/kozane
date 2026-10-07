<script lang="ts">
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { buildTagTree, normalizeTag } from "$lib/tag";
  import NavIcon from "$lib/components/NavIcon.svelte";
  import TagPanel from "./components/TagPanel.svelte";
  import MapZoomControl from "./components/MapZoomControl.svelte";
  import ActivityStrip from "./components/ActivityStrip.svelte";
  import MapDescription from "./components/MapDescription.svelte";
  import { mapHref } from "./lib/map-href.js";
  import { DRAG_THRESHOLD, MAP_DEFAULT_VIEWPORT } from "$lib/constants";
  import {
    buildMapLayout,
    tagLinks,
    HUB_RADIUS,
    LABEL_MIN_WIDTH,
    LABEL_MIN_HEIGHT,
  } from "./lib/map-layout.js";
  import {
    clampView,
    defaultView,
    pannedBy,
    viewedArea,
    zoomedBy,
    zoomedTo,
    isDefaultView,
    type MapView,
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

  let { data }: PageProps = $props();

  /**
   * Read the selected tag from URL-derived state. Clicking toggles its links, while hover
   * changes only row highlighting. Live pages use server query data, and static exports read
   * the browser URL.
   */
  const selectedTag = $derived.by(() => {
    if (data.tag) return data.tag;
    if (!browser) return null;
    const requested = page.url.searchParams.get("tag");
    return requested ? normalizeTag(requested) : null;
  });

  const selectedNamespaceId = $derived(
    data.namespaceId ?? (browser ? page.url.searchParams.get("namespaceId") : null),
  );
  const selectedNamespace = $derived(data.namespaces.find(({ id }) => id === selectedNamespaceId) ?? null);
  const selectedDay = $derived(
    data.day ?? (browser ? page.url.searchParams.get("day") : null),
  );

  // Keep day filtering of partition sizes and tag hits aligned. See `partitionsForDay`.
  const displayedPartitions = $derived(partitionsForDay(data.partitions, data.activity, selectedDay));
  const displayedTagHits = $derived(tagHitsForDay(data.tagHits, data.tagCards, selectedDay));
  const tree = $derived(buildTagTree(displayedTagHits));
  const mapTags = $derived(tagPartitionIndex(displayedTagHits, data.tagCards));

  const heatmap = $derived(
    activityCells(
      data.activity.map(({ day, cards }) => ({ day, cards })),
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
  let movedView = $state<MapView | null>(null);
  const rawView = $derived(movedView ?? defaultView(size));
  const view = $derived(clampView(rawView, size));
  const atDefault = $derived(isDefaultView(view, size));

  /**
   * Lay out the map within the view rectangle so zoom changes areas while labels and gaps
   * retain their pixel sizes.
   */
  const layout = $derived(
    buildMapLayout({
      namespaces: data.drawn,
      partitions: displayedPartitions,
      scopes: data.scopes,
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
  let origin: { x: number; y: number; view: MapView } | null = null;

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
    // Captured only once the gesture is a drag, not on the way down. A captured pointer's
    // `click` is dispatched to the capturing element rather than to what is under it, so
    // capturing on `pointerdown` left every partition link showing a pointer and opening
    // nothing.
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

  /** Swallows the click that ends a drag, so panning off a partition does not open its board.
   *  In the capture phase, which is the only place it is still ahead of the link. */
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
      const delta = event.deltaY < 0 ? data.zoomStep : -data.zoomStep;
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
  const tagHref = (tag: string | null) => mapHref(base, { ...current, tag });
  const namespaceHref = (namespaceId: string | null) => mapHref(base, { ...current, namespaceId });
  const dayHref = (day: string | null) => mapHref(base, { ...current, day });

  /**
   * Keep partitions fully opaque unless an active tag reaches other partitions but not this
   * one.
   */
  const lit = (partitionId: string) => !dimming || targets.has(partitionId);

  /**
   * Show labels only when the drawn rectangle meets shared minimum dimensions. Keep text size
   * fixed during zoom so small regions can grow large enough to label.
   */
  const roomForLabel = (rect: { width: number; height: number }) =>
    rect.width >= LABEL_MIN_WIDTH && rect.height >= LABEL_MIN_HEIGHT;

  /**
   * Use dim navigation icons with enlarged hit targets so they remain separate from the map
   * and easy to activate.
   */
  const headerLinkClass = css({
    display: "flex",
    alignItems: "center",
    // Only ever between the icon and a name, so it costs nothing on the icon-only link.
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
      href="{base}/{selectedNamespaceId ?? ''}"
      title={selectedNamespace ? undefined : "Namespaces"}
      aria-label={selectedNamespace ? `Back to ${selectedNamespace.name}` : "All namespaces"}
      class={headerLinkClass}
    >
      <NavIcon kind="namespaces" />
      {#if selectedNamespace}
        <span>{selectedNamespace.name}</span>
      {/if}
    </a>
    <a href="{base}/tags" title="Tags" aria-label="Tags" class={headerLinkClass}>
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
        // Sideways rather than onto a second line — see `MAP_HEADER_HEIGHT`. A workspace of
        // thirty namespaces scrolls its list; it does not take a second band off the map.
        overflowX: "auto",
        whiteSpace: "nowrap",
        scrollbarWidth: "none",
      })}
    >
      {#each data.namespaces as namespace (namespace.id)}
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

  {#if data.drawn.length !== 0}
    {#if tree.length !== 0}
      <TagPanel
        {tree}
        {selectedTag}
        cardsTruncated={data.cardsTruncated}
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
          // Zoomed in, the packing is larger than the window. Clipped to it rather than
          // drawn past the edges — and it is the bottom of the stack, so the header and the
          // panel are over it rather than under.
          overflow: "hidden",
          touchAction: "none",
          cursor: dragging ? "grabbing" : "grab",
        })}
      >
        <svg
          width={size.width}
          height={size.height}
          viewBox="0 0 {size.width} {size.height}"
          aria-label={selectedDay
            ? `Namespaces and partitions by cards changed on ${selectedDay}`
            : "Namespaces and partitions by card count, with the scopes and tags that cross between them"}
          class={css({ display: "block" })}
        >
          {#each layout.namespaces as namespace (namespace.id)}
            <g opacity={dimming ? 0.55 : 1}>
              <!-- Outline empty namespaces so they remain visible and distinct from small non-empty namespaces. -->
              <rect
                x={namespace.rect.x}
                y={namespace.rect.y}
                width={namespace.rect.width}
                height={namespace.rect.height}
                rx="2"
                fill={namespace.empty ? "transparent" : "var(--colors-ink-white)"}
                stroke="var(--colors-neutral-border)"
                stroke-dasharray={namespace.empty ? "2 2" : undefined}
              />
              {#if roomForLabel(namespace.rect)}
                <text
                  x={namespace.rect.x + 8}
                  y={namespace.rect.y + 14}
                  font-size="11"
                  font-family="var(--fonts-mono)"
                  fill="var(--colors-neutral-muted)"
                >{namespace.name}</text>
              {/if}
            </g>
          {/each}

          {#each layout.partitions as placed (placed.partition.id)}
            {@const rect = placed.rect}
            <a href="{base}/{placed.partition.namespaceId}" aria-label="{placed.partition.name}, {placed.partition.cards} cards, in the namespace it belongs to">
              <g opacity={lit(placed.partition.id) ? 1 : 0.25}>
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  rx="2"
                  fill={placed.empty ? "transparent" : placed.partition.bg}
                  stroke={placed.partition.dot}
                  stroke-width={placed.empty ? 1 : 0.5}
                  stroke-dasharray={placed.empty ? "2 2" : undefined}
                />
                {#if roomForLabel(rect)}
                  <text
                    x={rect.x + 6}
                    y={rect.y + 14}
                    font-size="11"
                    fill="var(--colors-ink-content)"
                  >{placed.partition.name}</text>
                  {#if rect.height >= 34}
                    <text
                      x={rect.x + 6}
                      y={rect.y + 28}
                      font-size="10"
                      font-family="var(--fonts-mono)"
                      fill="var(--colors-neutral-muted)"
                    >{placed.partition.cards}</text>
                  {/if}
                {/if}
              </g>
            </a>
          {/each}

          <!-- Keep scope edges subdued over the map rectangles. Highlight a hub's edges on hover. -->
          {#each layout.scopes as scope (scope.id)}
            <g class={css({ _hover: { opacity: "1 !important" } })} opacity={dimming ? 0.2 : 0.6}>
              {#each scope.spokes as spoke (spoke.id)}
                <path
                  d={spoke.path}
                  fill="none"
                  stroke="var(--colors-neutral-muted)"
                  stroke-width="1"
                />
              {/each}
              <circle
                cx={scope.point.x}
                cy={scope.point.y}
                r={HUB_RADIUS}
                fill="var(--colors-ink-white)"
                stroke="var(--colors-neutral-muted)"
              />
              <text
                x={scope.point.x}
                y={scope.point.y + HUB_RADIUS + 12}
                text-anchor="middle"
                font-size="10"
                font-family="var(--fonts-mono)"
                fill="var(--colors-neutral-subtle)"
              >{scope.name}</text>
            </g>
          {/each}

          <!-- The active tag's lines, drawn last so they sit over everything they cross. -->
          {#each links as link (link.id)}
            <path
              d={link.path}
              fill="none"
              stroke="var(--colors-select-accent)"
              stroke-width="1.5"
              opacity="0.85"
            />
          {/each}
        </svg>

        <MapZoomControl
          zoom={view.zoom}
          zoomStep={data.zoomStep}
          {atDefault}
          onZoomBy={(delta) => (movedView = zoomedBy(view, size, delta))}
          onReset={() => (movedView = null)}
        />
      </div>

      <ActivityStrip cells={heatmap} {selectedDay} rangeLabel={activityRange} {dayHref} />

    <MapDescription {layout} />
  {/if}
</main>
