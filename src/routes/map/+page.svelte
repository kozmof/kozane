<script lang="ts">
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { normalizeTag, CARDS_TRUNCATED_LABEL, type TagNode } from "$lib/tag";
  import NavIcon from "$lib/components/NavIcon.svelte";
  import { MAP_DEFAULT_VIEWPORT } from "$lib/constants";
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
    zoomPercent,
    type MapView,
  } from "./lib/view.js";
  import { tagBundleTargets } from "./lib/graph.js";
  import {
    childrenShown,
    tagLineOrigin,
    visibleTagRows,
    MAP_HEADER_HEIGHT,
    TAG_PANEL_LEFT,
    TAG_PANEL_TOP,
    TAG_PANEL_WIDTH,
    TAG_ROW_HEIGHT,
  } from "./lib/tag-rows.js";

  /**
   * The whole workspace in one picture: every project a rectangle, its bundles inside it
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
   * this component — which is what makes a drawn map a link somebody can send, and why
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

  const selectedProjectId = $derived(
    data.projectId ?? (browser ? page.url.searchParams.get("projectId") : null),
  );
  const selectedProject = $derived(data.projects.find(({ id }) => id === selectedProjectId) ?? null);

  /**
   * The box the map is drawn into.
   *
   * Measured in the browser, and {@link MAP_DEFAULT_VIEWPORT} before anything has measured
   * anything — on the server, and in a static export rendered on a machine with no browser.
   * That is what makes the served HTML a map rather than an empty frame waiting for
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
  /** Whether the map is where it opens. Compared by value, and against the clamped default,
   *  so a map panned back by hand counts as home and a box too small to hold the default
   *  does not leave the way back permanently offered. */
  const atDefault = $derived.by(() => {
    const home = clampView(defaultView(size), size);
    return view.zoom === home.zoom && view.panX === home.panX && view.panY === home.panY;
  });

  /**
   * The packing, laid into the rectangle the view describes rather than into the box on the
   * page — see `lib/view.ts` for why the zoom is applied here rather than as a transform on
   * the finished drawing.
   */
  const layout = $derived(
    buildMapLayout({
      projects: data.drawn,
      bundles: data.bundles,
      scopes: data.scopes,
      area: viewedArea(size, view),
    }),
  );

  /**
   * Dragging the map about.
   *
   * Every pointer that goes down on the map pans it, wherever it landed — the packing covers
   * the whole box, so a drag that only worked on the gaps between rectangles would have
   * almost nowhere to start. A bundle is a link, though, so `travelled` remembers whether
   * this gesture moved far enough to have been a drag, and the click that follows is
   * swallowed if it did. Otherwise every attempt to pan from a rectangle would open its
   * board.
   */
  const DRAG_THRESHOLD = 4;
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
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) travelled = true;
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

  /** Swallows the click that ends a drag, so panning off a bundle does not open its board.
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

  /** Which bundles the active tag reaches, rolled up over its subcategories — see
   *  `tagBundleTargets`. Empty when nothing is selected or hovered, which is the ordinary
   *  state of the page. */
  const targets = $derived(selectedTag ? tagBundleTargets(data.tagBundles, selectedTag) : new Map());

  /**
   * The rows the panel is drawing, and the point on the canvas the active one's lines leave
   * from.
   *
   * Worked out from the tree rather than measured off the page — see `lib/tag-rows.ts`. The
   * panel is drawn over the canvas at a known corner, so a row's offset down it is a y on the
   * map without either being measured. That is what makes a line right in the served HTML,
   * before any JavaScript has run, and right in a static export opened without any.
   *
   * `panelScroll` is the exception, and it is zero until someone scrolls a tree too tall for
   * the window — so it changes nothing about what is served, only about what a line does
   * after the row it belongs to has moved.
   */
  const rows = $derived(visibleTagRows(data.tree, selectedTag));
  let panelScroll = $state(0);
  const lineOrigin = $derived(tagLineOrigin(rows, selectedTag, panelScroll));

  const links = $derived(lineOrigin === null ? [] : tagLinks(layout, lineOrigin, targets));
  /** Whether the packing should stand back so the tag's lines read. Only once a tag is
   *  actually reaching somewhere — a tag written on no card dims nothing. */
  const dimming = $derived(links.length > 0);

  const tagHref = (tag: string | null) => {
    const params = new URLSearchParams();
    if (selectedProjectId) params.set("projectId", selectedProjectId);
    if (tag) params.set("tag", tag);
    const query = params.toString();
    return query ? `${base}/map?${query}` : `${base}/map`;
  };
  const projectHref = (projectId: string | null) => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (selectedTag) params.set("tag", selectedTag);
    const query = params.toString();
    return query ? `${base}/map?${query}` : `${base}/map`;
  };

  /** Cards, and only cards: this page gathers no file tags, so `total.files` is always zero
   *  and a two-part label would be one part that never appears. */
  const countLabel = (node: TagNode) => `${node.total.cards}`;
  const countDescription = (node: TagNode) =>
    `${node.total.cards} card${node.total.cards === 1 ? "" : "s"}`;

  /** Whether a bundle is drawn at full strength: everything is, until a tag is reaching
   *  somewhere and this bundle is not one of the places. */
  const lit = (bundleId: string) => !dimming || targets.has(bundleId);

  /**
   * Enough room to read a label in. Below this the rectangle is drawn and left unlabelled
   * rather than carrying text wider than itself.
   *
   * Asked of the rectangle as drawn, which is what makes zooming worth doing: the label is
   * the same size at every zoom, so a bundle too small to carry one grows into it rather
   * than growing its text along with itself.
   *
   * The two measures come from `map-layout.ts` rather than being written here, because the empty
   * strip is sized to clear them — see `PROJECT_EMPTY_STRIP_HEIGHT`. Kept in this file, they
   * were a threshold the geometry could not read, and the strip cleared them by luck until it
   * stopped: an empty project used to reach the page too short to carry its own name, and so
   * was drawn as an unlabelled box belonging to nothing.
   */
  const roomForLabel = (rect: { width: number; height: number }) =>
    rect.width >= LABEL_MIN_WIDTH && rect.height >= LABEL_MIN_HEIGHT;

  /**
   * Every measurement this page shares with `lib/tag-rows.ts` is written as an inline
   * `style`, and none of them through `css()`.
   *
   * Panda extracts its atomic classes by reading the source, so a length interpolated from a
   * constant is a length it cannot evaluate where it stands. It emits the class name at
   * runtime all the same and no rule to go with it, which is silent in the worst way:
   * nothing fails to build, nothing fails to render, and the row is simply whatever height
   * its text came out at. That is the measurement every tag line is drawn from, so it is the
   * one thing here that must not be able to quietly not apply.
   */
  const rowStyle = `height: ${TAG_ROW_HEIGHT}px`;

  /**
   * Pinned to `TAG_ROW_HEIGHT` rather than left to come out of the font, because
   * `tagRowCenter` multiplies by it to decide where a tag's lines leave from. A row an odd
   * pixel taller than the constant would put every line below it out by a growing amount.
   * The height itself is in `rowStyle` — see the note there.
   */
  const rowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "0 8px",
    borderRadius: "2px",
    color: "ink.black",
    textDecoration: "none",
    fontSize: "13px",
    _hover: { backgroundColor: "neutral.bg" },
  });
  const activeRowClass = css({ backgroundColor: "neutral.bg", fontWeight: "600" });
  const countClass = css({ fontSize: "10.5px", color: "neutral.subtle", fontFamily: "mono" });
  /**
   * The links out of the map, which are icons and carry no text of their own.
   *
   * `neutral.icon` at rest, the weight the canvas draws its own rectangle icons at — and it
   * matters more here than on the project list, because this band is over the map itself and
   * a heavier icon would read as part of the drawing underneath it.
   *
   * Grown well past the 16px the icon occupies, for the same reason: a link the size of its
   * own artwork is a link you have to aim at, while the thing beneath it is waiting to be
   * dragged.
   */
  const headerLinkClass = css({
    display: "flex",
    alignItems: "center",
    padding: "6px",
    borderRadius: "2px",
    color: "neutral.icon",
    textDecoration: "none",
    _hover: { color: "ink.black", backgroundColor: "neutral.border" },
  });
</script>

<svelte:head>
  <title>{selectedProject ? `Map · ${selectedProject.name}` : "Map"}</title>
</svelte:head>

{#snippet branch(nodes: TagNode[], depth: number)}
  <ul class={css({ listStyle: "none", margin: "0", padding: "0" })}>
    {#each nodes as node (node.tag)}
      <li>
        <a
          href={tagHref(selectedTag === node.tag ? null : node.tag)}
          aria-current={selectedTag === node.tag ? "page" : undefined}
          style="{rowStyle}; padding-left: {8 + depth * 14}px"
          class="{rowClass} {selectedTag === node.tag ? activeRowClass : ''}"
        >
          <span class={css({ fontFamily: "mono" })}>{node.name}</span>
          <!-- Bare in the column, spelled out for a reader who cannot see the column. The
               same split the tag index makes. -->
          <span class={countClass} aria-hidden="true">{countLabel(node)}</span>
          <span class={css({ srOnly: true })}>{countDescription(node)}</span>
        </a>
        {#if childrenShown(node, depth, selectedTag)}
          {@render branch(node.children, depth + 1)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

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
    <!-- Where the icon has to give the name back: it is the same drawing whether it leads
         to the whole list or to one project's board, so which of those it is lives in the
         label rather than in the picture. -->
    <a
      href="{base}/{selectedProjectId ?? ''}"
      title={selectedProject ? selectedProject.name : "Projects"}
      aria-label={selectedProject ? `Back to ${selectedProject.name}` : "All projects"}
      class={headerLinkClass}
    >
      <NavIcon kind="projects" />
    </a>
    <a href="{base}/tags" title="Tags" aria-label="Tags" class={headerLinkClass}>
      <NavIcon kind="tags" />
    </a>

    <!-- Which project the map is narrowed to, and the way to change it. Picking the project
         already selected clears the narrowing, which is the way back to the whole workspace.
         The same control the tag index carries, in the same place. -->
    <nav
      aria-label="Project"
      class={css({
        display: "flex",
        gap: "10px",
        marginLeft: "auto",
        // Sideways rather than onto a second line — see `MAP_HEADER_HEIGHT`. A workspace of
        // thirty projects scrolls its list; it does not take a second band off the map.
        overflowX: "auto",
        whiteSpace: "nowrap",
        scrollbarWidth: "none",
      })}
    >
      {#each data.projects as project (project.id)}
        {@const selected = selectedProjectId === project.id}
        <a
          href={projectHref(selected ? null : project.id)}
          aria-current={selected ? "page" : undefined}
          class={css({
            textDecoration: "none",
            color: "neutral.subtle",
            _hover: { color: "ink.black" },
          })}
          style={selected ? "color: var(--colors-ink-black); font-weight: 600" : ""}
        >
          {project.name}
        </a>
      {/each}
    </nav>
  </header>

  {#if data.drawn.length === 0}
    <p
      style="top: {TAG_PANEL_TOP}px"
      class={css({
        position: "absolute",
        left: "16px",
        color: "neutral.subtle",
        fontSize: "13px",
        maxWidth: "52ch",
      })}
    >
      No projects yet. A project is drawn here as a rectangle, and the bundles inside it are
      sized by how many cards each one holds.
    </p>
  {:else}
    <!--
      The tag panel, floating at the corner `tagLineOrigin` draws from — so the numbers that
      place it and the numbers a line starts at are one set of numbers.

      A scroller, which it did not used to be. Beside the map it could be any height and the
      page scrolled to reach the bottom of it; over a window-height canvas there is no page
      scroll left to do that, and a tree taller than the window would simply have tags that
      could not be reached. What it costs is `panelScroll`: the one measured quantity on a
      page that is otherwise pure arithmetic, and zero until someone actually scrolls.

      No vertical padding and no border, deliberately. `tagRowCenter` counts rows from this
      element's top edge, so anything between that edge and the first row is an offset every
      line below would be out by.
    -->
    <nav
      aria-label="Tags"
      onscroll={(event) => (panelScroll = event.currentTarget.scrollTop)}
      style="left: {TAG_PANEL_LEFT}px; top: {TAG_PANEL_TOP}px; width: {TAG_PANEL_WIDTH}px; max-height: calc(100% - {TAG_PANEL_TOP + 16}px)"
      class={css({
        position: "absolute",
        zIndex: "1",
        boxSizing: "border-box",
        overflowY: "auto",
        overscrollBehavior: "contain",
        padding: "0 4px",
        scrollbarWidth: "thin",
      })}
    >
        {#if data.tree.length === 0}
          <p class={css({ color: "neutral.subtle", fontSize: "12px", padding: "3px 8px" })}>
            No tags yet. Write <code class={css({ fontFamily: "mono" })}>'like:this</code> in a
            card and it is gathered here.
          </p>
        {:else}
          {@render branch(data.tree, 0)}
          {#if data.cardsTruncated || data.tagLinksTruncated}
            <p
              class={css({
                fontSize: "11px",
                color: "neutral.subtle",
                padding: "8px",
                maxWidth: "34ch",
              })}
            >
              {data.cardsTruncated ? CARDS_TRUNCATED_LABEL : ""}
              {data.tagLinksTruncated
                ? "Some tags reach more bundles than this page draws lines for."
                : ""}
            </p>
          {/if}
        {/if}
      </nav>

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
          aria-label="Projects and bundles by card count, with the scopes and tags that cross between them"
          class={css({ display: "block" })}
        >
          {#each layout.projects as project (project.id)}
            <g opacity={dimming ? 0.55 : 1}>
              <!-- A project holding no cards anywhere is drawn as the outline an empty
                   bundle is, and for the same reason: it is in the map because leaving it
                   out would say it does not exist, and it should not be mistaken for a
                   project that merely packed small. -->
              <rect
                x={project.rect.x}
                y={project.rect.y}
                width={project.rect.width}
                height={project.rect.height}
                rx="2"
                fill={project.empty ? "transparent" : "var(--colors-ink-white)"}
                stroke="var(--colors-neutral-border)"
                stroke-dasharray={project.empty ? "2 2" : undefined}
              />
              {#if roomForLabel(project.rect)}
                <text
                  x={project.rect.x + 8}
                  y={project.rect.y + 14}
                  font-size="11"
                  font-family="var(--fonts-mono)"
                  fill="var(--colors-neutral-muted)"
                >{project.name}</text>
              {/if}
            </g>
          {/each}

          {#each layout.bundles as placed (placed.bundle.id)}
            {@const rect = placed.rect}
            <a href="{base}/{placed.bundle.projectId}" aria-label="{placed.bundle.name}, {placed.bundle.cards} cards, in the project it belongs to">
              <g opacity={lit(placed.bundle.id) ? 1 : 0.25}>
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  rx="2"
                  fill={placed.empty ? "transparent" : placed.bundle.bg}
                  stroke={placed.bundle.dot}
                  stroke-width={placed.empty ? 1 : 0.5}
                  stroke-dasharray={placed.empty ? "2 2" : undefined}
                />
                {#if roomForLabel(rect)}
                  <text
                    x={rect.x + 6}
                    y={rect.y + 14}
                    font-size="11"
                    fill="var(--colors-ink-content)"
                  >{placed.bundle.name}</text>
                  {#if rect.height >= 34}
                    <text
                      x={rect.x + 6}
                      y={rect.y + 28}
                      font-size="10"
                      font-family="var(--fonts-mono)"
                      fill="var(--colors-neutral-muted)"
                    >{placed.bundle.cards}</text>
                  {/if}
                {/if}
              </g>
            </a>
          {/each}

          <!-- The scope graph. Quiet by default: it is drawn over the packing, and a scope
               reaching six bundles is six lines that would otherwise compete with the
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

        <!-- The board's control, in the board's corner and to the board's limits, so the two
             pages are zoomed the same way. The reading doubles as the way back: there is no
             scrollbar here to say how far the map has been moved, so the one thing that
             always says where you are is also the thing that puts you back. -->
        <div
          class={css({
            position: "absolute",
            bottom: "12px",
            right: "12px",
            display: "flex",
            alignItems: "center",
            gap: "1px",
            backgroundColor: "ink.light",
            borderRadius: "2px",
            border: "1px solid token(colors.neutral.dim)",
            boxShadow: "0 1px 6px rgba(0,0,0,0.018)",
            overflow: "hidden",
          })}
        >
          {#each [["Zoom out", -data.zoomStep], ["Zoom in", data.zoomStep]] as [label, delta] (label)}
            <button
              type="button"
              aria-label={label as string}
              onclick={() => (movedView = zoomedBy(view, size, delta as number))}
              class={css({
                width: "30px",
                height: "26px",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "ink.secondary",
                padding: "0",
                fontFamily: "mono",
                fontSize: "13px",
                lineHeight: "1",
              })}
            >{label === "Zoom in" ? "+" : "−"}</button>
          {/each}
          <button
            type="button"
            disabled={atDefault}
            title={atDefault ? "At the size the map opens at" : "Back to the size the map opens at"}
            onclick={() => (movedView = null)}
            class={css({
              padding: "0 8px",
              height: "26px",
              minWidth: "48px",
              fontSize: "11px",
              fontFamily: "mono",
              color: "neutral.secondary",
              background: "transparent",
              border: "none",
              borderLeft: "1px solid token(colors.neutral.dim)",
              cursor: "pointer",
              _disabled: { cursor: "default" },
            })}
          >{zoomPercent(view.zoom)}%</button>
        </div>
      </div>

    <!--
      The same map in words, for a reader who cannot see it. An `<svg>` with one label says
      what the picture is about and nothing about what is in it, and every number on this page
      is in the picture.
    -->
    <div class={css({ srOnly: true })}>
      <h2>What the map shows</h2>
      <ul>
        {#each layout.projects as project (project.id)}
          <li>
            {project.name}: {project.cards} card{project.cards === 1 ? "" : "s"}
            <ul>
              {#each layout.bundles.filter((b) => b.bundle.projectId === project.id) as placed (placed.bundle.id)}
                <li>
                  {placed.bundle.name}: {placed.bundle.cards} card{placed.bundle.cards === 1
                    ? ""
                    : "s"}
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
      {#if layout.scopes.length > 0}
        <h2>Scopes across the map</h2>
        <ul>
          {#each layout.scopes as scope (scope.id)}
            <li>{scope.name}: reaches {scope.spokes.length} of them</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</main>
