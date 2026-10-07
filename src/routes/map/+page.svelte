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
   * The whole workspace in one picture: every namespace a rectangle, its partitions inside it
   * sized by the cards they hold, the scopes that cross between them a graph under the
   * packing, and the tags the tree they spell.
   *
   * Nothing here writes. The board is where a workspace is changed; this is where its shape
   * is looked at, so every interaction on the page is a link or a gesture that moves it.
   */

  let { data }: PageProps = $props();

  /**
   * The tag whose lines are drawn — and the only thing that decides it.
   *
   * Hovering used to preview a tag as well, and it read as the map flickering: a pointer
   * crossing the panel on its way somewhere else lit up every row it passed over, and the
   * drawing a reader was looking at kept being replaced by one they had not asked for. Now
   * a click draws the lines and they stay drawn, clicking the same row again clears them,
   * and moving the pointer over the tree changes nothing but the row's own highlight.
   *
   * That leaves one piece of state instead of two, and it lives in the URL rather than in
   * this component — which makes a drawn map a link somebody can send, and why
   * there is no setter here: every way of changing which tag is drawn is a navigation.
   *
   * What the URL asks for. `data.*` on the live page, where the server read the query; from
   * the URL in a static export, which is prerendered and so had no query to read at build
   * time. One value either way, so everything below reads the same on both. The same
   * arrangement the tag index uses, for the same reason.
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

  // The two halves of one decision — see `partitionsForDay`, which says why they are not two.
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
   * The box the map is drawn into.
   *
   * Measured in the browser, and {@link MAP_DEFAULT_VIEWPORT} before anything has measured
   * anything — on the server, and in a static export rendered on a machine with no browser.
   * That makes the served HTML a map rather than an empty frame waiting for
   * hydration; the browser then repacks at the real size through the same function, so what
   * changes on mount is the size and not the arrangement.
   */
  let measuredWidth = $state(0);
  let measuredHeight = $state(0);
  const size = $derived(
    measuredWidth > 0 && measuredHeight > 0
      ? { width: measuredWidth, height: measuredHeight }
      : MAP_DEFAULT_VIEWPORT,
  );

  /**
   * Where the map is being looked at from.
   *
   * Held raw and clamped on the way out, so the box being resized cannot leave a pan the
   * clamp would no longer allow — and so nothing has to re-clamp what is already stored.
   *
   * `null` is the opening view rather than a copy of it, because `defaultView` centres the
   * map in the box and the box is not known until the browser has measured it. Stored as a
   * value, the pan the server centred `MAP_DEFAULT_VIEWPORT` at would survive into a window
   * of another size and sit the map slightly off-centre for as long as nobody touched it.
   */
  let movedView = $state<MapView | null>(null);
  const rawView = $derived(movedView ?? defaultView(size));
  const view = $derived(clampView(rawView, size));
  const atDefault = $derived(isDefaultView(view, size));

  /**
   * The packing, laid into the rectangle the view describes rather than into the box on the
   * page — see `lib/view.ts` for why the zoom is applied here rather than as a transform on
   * the finished drawing.
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
   * Dragging the map about.
   *
   * Every pointer that goes down on the map pans it, wherever it landed — the packing covers
   * the whole box, so a drag that only worked on the gaps between rectangles would have
   * almost nowhere to start. A partition is a link, though, so `travelled` remembers whether
   * this gesture moved far enough to have been a drag, and the click that follows is
   * swallowed if it did. Otherwise every attempt to pan from a rectangle would open its
   * board.
   */
  // The shared figure, not a local copy of it — this was `const DRAG_THRESHOLD = 4`, the
  // seventh spelling of the board's click-versus-drag threshold and the only one outside
  // `KozaneCanvas.svelte`.
  //
  // Only the number is shared. The comparison below is this page's own: a Manhattan sum
  // (`|dx| + |dy|`) rather than the per-axis test `travelled` in `lib/gesture.ts` makes, so a
  // gesture that creeps diagonally arms slightly sooner here. That is deliberate and left
  // alone — the map swallows a click on a partition link, where the board writes a position
  // patch, and being a shade eager to call a wobble a pan is the forgiving direction when the
  // cost of being wrong is opening a board the user did not ask for.
  let dragging = $state(false);
  let travelled = false;
  let origin: { x: number; y: number; view: MapView } | null = null;

  function onPointerDown(event: PointerEvent) {
    // The primary button only: a right-click is the context menu, and a middle-click is the
    // browser's own scroll gesture.
    if (event.button !== 0) return;
    origin = { x: event.clientX, y: event.clientY, view };
    dragging = true;
    // Cleared here rather than after the click, because a drag released outside the map
    // produces no click at all — and a flag left standing would swallow the next real one.
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
   * Zooming toward the pointer, on `Ctrl`/`Cmd` and the wheel — the board's gesture, and
   * the same `ui.zoomStep` behind it.
   *
   * Registered by hand rather than with `onwheel` because it has to call
   * `preventDefault`: without `passive: false` the browser is entitled to ignore that and
   * zoom the whole page underneath the map instead. A wheel without the modifier is left
   * alone, so the page still scrolls.
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

  /** Which partitions the active tag reaches, rolled up over its subcategories — see
   *  `tagPartitionTargets`. Empty when nothing is selected or hovered, which is the ordinary
   *  state of the page. */
  const targets = $derived(
    selectedTag ? tagPartitionTargets(mapTags.index, selectedTag) : new Map(),
  );

  /**
   * The rows the panel is drawing, and the point on the canvas the active one's lines leave
   * from.
   *
   * Worked out from the tree rather than measured off the page — see `lib/tag-rows.ts`. The
   * panel is drawn over the canvas at a known corner, so a row's offset down it is a y on the
   * map without either being measured. That makes a line right in the served HTML,
   * before any JavaScript has run, and right in a static export opened without any.
   *
   * `panelScroll` is the exception, and it is zero until someone scrolls a tree too tall for
   * the window — so it changes nothing about what is served, only about what a line does
   * after the row it belongs to has moved.
   */
  const rows = $derived(visibleTagRows(tree, selectedTag));
  let panelScroll = $state(0);
  const lineOrigin = $derived(tagLineOrigin(rows, selectedTag, panelScroll));

  const links = $derived(lineOrigin === null ? [] : tagLinks(layout, lineOrigin, targets));
  /** Whether the packing should stand back so the tag's lines read. Only once a tag is
   *  actually reaching somewhere — a tag written on no card dims nothing. */
  const dimming = $derived(links.length > 0);

  // The page's links to itself: one narrowing changed, the other two carried over.
  const current = $derived({ namespaceId: selectedNamespaceId, tag: selectedTag, day: selectedDay });
  const tagHref = (tag: string | null) => mapHref(base, { ...current, tag });
  const namespaceHref = (namespaceId: string | null) => mapHref(base, { ...current, namespaceId });
  const dayHref = (day: string | null) => mapHref(base, { ...current, day });

  /** Whether a partition is drawn at full strength: everything is, until a tag is reaching
   *  somewhere and this partition is not one of the places. */
  const lit = (partitionId: string) => !dimming || targets.has(partitionId);

  /**
   * Enough room to read a label in. Below this the rectangle is drawn and left unlabelled
   * rather than carrying text wider than itself.
   *
   * Asked of the rectangle as drawn, which makes zooming worth doing: the label is
   * the same size at every zoom, so a partition too small to carry one grows into it rather
   * than growing its text along with itself.
   *
   * The two measures come from `map-layout.ts` rather than being written here, because the empty
   * strip is sized to clear them — see `NAMESPACE_EMPTY_STRIP_HEIGHT`. Kept in this file, they
   * were a threshold the geometry could not read, and the strip cleared them by luck until it
   * stopped: an empty namespace used to reach the page too short to carry its own name, and so
   * was drawn as an unlabelled box belonging to nothing.
   */
  const roomForLabel = (rect: { width: number; height: number }) =>
    rect.width >= LABEL_MIN_WIDTH && rect.height >= LABEL_MIN_HEIGHT;

  /**
   * The links out of the map, which are icons and carry no text of their own.
   *
   * `neutral.iconDim` at rest, an icon's weight rather than a label's — and the balance
   * matters more here than on the namespace list, because this band is over the map itself:
   * heavier and the icons read as part of the drawing underneath, lighter and they vanish
   * into it.
   *
   * Grown well past the 16px the icon occupies, for the same reason: a link the size of its
   * own artwork is a link you have to aim at, while the thing beneath it is waiting to be
   * dragged.
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

<!--
  The window, and nothing but the map in it. The canvas fills it edge to edge and everything
  else — the header, the tag panel, the zoom control — is drawn over it rather than beside
  it, because a treemap laid into what is left over after the furniture has taken its share
  is a treemap of a smaller workspace: every rectangle is scaled down by the same fraction,
  and the small ones fall under the size a label needs first.

  `height` rather than `min-height`, and the overflow hidden with it: this page does not
  scroll. The map is moved by dragging it, which is the board's gesture and the one the rest
  of this page is built around — a page that also scrolled would have two answers to "move
  the map down", and the tag lines are drawn in window coordinates that a page scroll would
  slide out from under.
-->
<main
  class={css({
    position: "relative",
    height: "100dvh",
    overflow: "hidden",
    backgroundColor: "ink.lighter",
  })}
>
  <!-- Over the map, and letting a drag through where there is nothing to click: the band
       runs the width of the window, and a strip that swallowed every gesture that began in
       it would be a strip of dead map. `pointer-events` is handed back by the links
       themselves. -->
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
    <!-- Back to the namespace list, or to one namespace's board when the map has been narrowed
         to it. The icon is the same drawing either way, so the name is what says which — and
         it is worth the room, because the two destinations are not interchangeable and the
         picture alone cannot tell them apart. The same link the tag index carries. -->
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

      <!--
        The map, and the surface that is dragged to pan it. `touch-action: none` hands the
        touch gestures over rather than letting the browser scroll the page under a drag,
        and the pointer is captured so a drag that leaves the box keeps going.

        `role="presentation"`, and no keyboard model of its own — the board's canvas is
        exactly this and answers it exactly this way. The surface is a way of moving the
        picture, not a thing to be read: what a screen reader should get is the words below,
        which say what the map shows and are read the ordinary way. Zooming is still reachable
        without a mouse, through the buttons in the corner; making the surface itself
        focusable as well would put a stop on the tab order that announced nothing and, at
        `role="application"`, would take a screen reader out of its own reading commands to
        buy arrow keys for a picture it is not reading.
      -->
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
              <!-- A namespace holding no cards anywhere is drawn as the outline an empty
                   partition is, and for the same reason: it is in the map because leaving it
                   out would say it does not exist, and it should not be mistaken for a
                   namespace that merely packed small. -->
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

          <!-- The scope graph. Quiet by default: it is drawn over the packing, and a scope
               reaching six partitions is six lines that would otherwise compete with the
               rectangles they cross. Hovering a hub raises its own. -->
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
