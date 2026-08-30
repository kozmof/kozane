<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { goto, replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import {
    createCard,
    updateCard,
    patchCardPositions,
    fetchWarpDirectory,
    parseWarpEntries,
    deleteWarp,
    failureMessage,
  } from "./lib/project-api.js";
  import {
    applyPalette,
    ARROW_DIRECTIONS,
    clampZoom,
    maxZIndex,
    minZIndex,
    warpInDirection,
  } from "./lib/project-page.js";
  import type { CardPositionPatch } from "./lib/project-page.js";
  import {
    cardMetrics,
    warpEntriesForProject,
    withoutWarp,
    type WarpListEntry,
  } from "$lib/warp-list";
  import type { CardWithGlue } from "$lib/types";
  import { ProjectState, storeActiveLayerId } from "./project-state.svelte.js";
  import { createProjectActions } from "./project-actions.svelte.js";
  import BundleSidebar from "./components/BundleSidebar.svelte";
  import ScopeSidebar from "./components/ScopeSidebar.svelte";
  import KozaneCanvas from "./components/KozaneCanvas.svelte";
  import FloatingControls from "./components/FloatingControls.svelte";
  import LayerControl from "./components/LayerControl.svelte";
  import ScopeControl from "./components/ScopeControl.svelte";
  import FloatingComposer from "./components/FloatingComposer.svelte";
  import WarpPalette from "./components/WarpPalette.svelte";
  import ErrorBanner from "./components/ErrorBanner.svelte";
  import FileEditor from "./components/FileEditor.svelte";
  import { EditorSession } from "./lib/editor/editor-session.svelte.js";
  import { Activity } from "./lib/activity.js";
  import { startSnapshotPoll } from "./lib/snapshot-poll.js";

  let { data }: PageProps = $props();

  // Static exports (kozane net ssg generate) are read-only: no mutation endpoints exist, so all
  // editing affordances and the live-sync poll are disabled. Build-wide and constant.
  const readonly = untrack(() => data.readonly);
  // Present only in a static export built with `--include-scoped-files`. Read-only browsing
  // and file-opening stay live wherever a taskspace has one of these; without it, a readonly
  // taskspace falls back to the plain, non-expandable label it always was.
  // Derived, not captured the way `readonly` above is: these trees belong to one project and
  // are keyed by its taskspace ids, and warping in from another project reuses this component.
  // Holding on to the project we happened to land on would leave every later project matching
  // nothing here — and in an export, where `path` is null, with no listable taskspaces at all.
  const staticFiles = $derived(data.taskspaceFiles);

  // ── Reactive project state ────────────────────────────────────
  const s = new ProjectState();
  s.fetcher = fetch;
  // The same path project navigation takes below. Loading a project decides more than a
  // list of fields now — which layer it was last worked on, among them — and that belongs
  // in one place rather than being repeated here and kept in step by hand.
  untrack(() => s.resetFromData(data));

  // ── UI state ──────────────────────────────────────────────────
  let sidebarsVisible = $state(untrack(() => data.uiConfig.defaultShowSidePanel));
  let showFooters = $state(untrack(() => data.uiConfig.defaultShowFooter));
  let warpsVisible = $state(untrack(() => data.uiConfig.defaultShowWarps));
  let zoom = $state(untrack(() => data.uiConfig.defaultZoom));
  let warpPaletteOpen = $state(false);
  // The taskspace file the editor has open, if any. One at a time: the panel is a place to
  // work on a file, not a set of tabs, and a second one would want somewhere to put them.
  const editor = new EditorSession();
  // Held here rather than in the panel so it outlives closing a file: the width someone
  // dragged to is about the workspace, not about the file that happened to be open. Null
  // until dragged, when the responsive default applies. Per tab, and not stored, so a
  // reload starts from the default again.
  let editorWidth = $state<number | null>(null);
  // Every other project's warps. Loaded with the page so the palette opens filled in, and
  // re-fetched when it opens so a warp set elsewhere since then is not missing.
  // `?? []`: a static export built before this feature has no directory in its page data.
  let warpDirectory = $state.raw<WarpListEntry[]>(untrack(() => data.warpDirectory ?? []));
  let newCardSeq = 0;
  // A drag in progress, and the save that follows it. Held apart from `s.mutations`
  // because the canvas opens it before any request exists: the poll has to stand down for
  // the drag itself, not only for the PATCH at the end of it.
  const positionActivity = new Activity();

  // ── Canvas component ref (for getNewCardPosition) ─────────────
  let canvasComponent: {
    getNewCardPosition: (seq: number) => { posX: number; posY: number };
    getViewCenter: () => { posX: number; posY: number };
    getWarpPosition: () => { posX: number; posY: number };
    isCenteredOn: (posX: number, posY: number) => boolean;
    centerOn: (posX: number, posY: number) => void;
    recenter: () => void;
  } = $state()!;
  let composerComponent: { focusInput: () => void } = $state()!;

  // ── Derived values ────────────────────────────────────────────
  let bundlesWithColors = $derived(applyPalette(s.bundles));
  let bundleColorById = $derived(new Map(bundlesWithColors.map((b) => [b.id, b])));
  let visibleCards = $derived(
    s.sidebar.activeBundle ? s.cards.filter((c) => c.bundleId === s.sidebar.activeBundle) : s.cards,
  );
  let scopeCardIds = $derived(
    s.sidebar.activeScope
      ? new Set(s.scopeRels.filter((r) => r.scopeId === s.sidebar.activeScope).map((r) => r.cardId))
      : null,
  );
  let defaultBundleId = $derived(s.sidebar.activeBundle ?? bundlesWithColors[0]?.id ?? "");
  // One pass over the cards instead of a scan per selected id. A selection is capped at
  // BATCH_MAX, so the pair-wise form was up to two thousand scans of the whole board on
  // every keystroke that touched the selection.
  let cardById = $derived(new Map(s.cards.map((c) => [c.id, c])));
  // `flatMap` rather than `map(...)!.filter(Boolean)`: an id whose card has gone — deleted
  // by the CLI between one poll and the next — is dropped here, and dropping it is exactly
  // what the `!` was asserting could not be necessary.
  let selectedCardObjects = $derived(
    [...s.selection.selectedCards].flatMap((id) => cardById.get(id) ?? []),
  );
  let selectionGlueRels = $derived(s.glueRels.filter((r) => s.selection.selectedCards.has(r.cardId)));
  let primaryCard = $derived(
    s.selection.primarySelectedId ? (cardById.get(s.selection.primarySelectedId) ?? null) : null,
  );
  // This project's rows come from live state rather than the server, so a warp just set
  // with the warp key is in the palette before any request comes back.
  let warpEntries = $derived([
    ...warpEntriesForProject({
      project: { id: data.project.id, name: data.project.name },
      warps: s.warps,
      cards: s.cards,
      metrics: cardMetrics(data.uiConfig),
      isCurrent: true,
    }),
    ...warpDirectory,
  ]);

  // ── Reset on project navigation ───────────────────────────────
  let loadedProjectId = $state(untrack(() => data.project.id));
  let loadedData = $state.raw(untrack(() => data));

  $effect(() => {
    if (data === loadedData) return;
    loadedData = data;
    if (data.project.id !== loadedProjectId) {
      loadedProjectId = data.project.id;
      // Only on a project change: the directory that arrives with a board is the one for
      // that board. A same-project reload would otherwise throw away the copy the palette
      // keeps fresh for itself — including a row it has just removed. `?? []`: as on the
      // initial read above, a static export built before this feature carries no
      // directory, and spreading `undefined` into the palette's rows would throw.
      warpDirectory = data.warpDirectory ?? [];
      s.resetFromData(data);
      newCardSeq = 0;
      sidebarsVisible = data.uiConfig.defaultShowSidePanel;
      showFooters = data.uiConfig.defaultShowFooter;
      warpsVisible = data.uiConfig.defaultShowWarps;
      zoom = data.uiConfig.defaultZoom;
      // Warping in from another project reuses this component, so the canvas never
      // remounts and its `initialCenter` never runs again: the landing happens here.
      openViewOnNewProject();
    } else {
      s.refreshFromData(data);
    }
  });

  /**
   * The warp named by `?warp=`, which is how a jump to another project says where it was
   * headed. Null whenever the id is absent or belongs to a warp this project no longer has.
   */
  function warpFromUrl() {
    // Only in the browser: prerendering a static export forbids reading the query, and a
    // warp landing is a client-side scroll anyway.
    if (!browser) return null;
    const warpId = page.url.searchParams.get("warp");
    return warpId ? (s.warps.find(({ id }) => id === warpId) ?? null) : null;
  }

  /**
   * Where the board a project navigation arrived at opens: on the warp the jump named, or
   * in the middle, as a project opened from a link does. Landing on the scroll offset the
   * project left behind — which is what reusing the canvas would otherwise do, after a
   * jump to a removed warp or a press of the browser's Back button — shows nothing in
   * particular.
   */
  function openViewOnNewProject() {
    const target = untrack(warpFromUrl);
    if (!target) {
      tick().then(() => canvasComponent.recenter());
      return;
    }
    focusWarp(target.id);
    tick().then(() => {
      canvasComponent.centerOn(target.posX, target.posY);
      clearQuery("warp");
    });
  }

  /**
   * Drops the parameters an arrival was directed by, so panning away and reloading does not
   * snap back to them. Only the ones named: anything else on the URL belongs to whoever put
   * it there. Best-effort: the URL is cosmetic here, and a router that is not ready yet is
   * not worth an error banner.
   */
  function clearQuery(...names: string[]) {
    const url = new URL(page.url);
    for (const name of names) url.searchParams.delete(name);
    try {
      replaceState(`${url.pathname}${url.search}`, {});
    } catch {
      // Ignored: see above.
    }
  }

  /**
   * The card named by `?card=`, which is how the tag index says which hit was clicked. Null
   * when the id is absent or names a card this project does not have — a tag page left open
   * while the card was deleted elsewhere.
   */
  function cardFromUrl() {
    if (!browser) return null;
    const cardId = page.url.searchParams.get("card");
    return cardId ? (s.cards.find(({ id }) => id === cardId) ?? null) : null;
  }

  /**
   * Opens what `?card=` and `?taskspace=&path=` name: the board centred on one card, or the
   * editor on one taskspace file. Both are how a tag hit gets back to the thing it was found
   * in, and both drop their parameters once they have been acted on, the same as `?warp=`.
   */
  function openFromUrl() {
    if (!browser) return;

    // Everything the URL is read for is read here, before anything is acted on, and every
    // parameter that was acted on is dropped in one call at the end. Acting and clearing were
    // interleaved, which left the card's clear reading `page.url` inside a `tick` — after the
    // file's clear had already replaced it — and made the two correct only in that order.
    const card = cardFromUrl();
    const taskspaceId = page.url.searchParams.get("taskspace");
    const path = page.url.searchParams.get("path");
    // A static export can open a file only where its contents were baked in; without them
    // there is nothing to read and no endpoint to read it from, so the link is left inert
    // rather than opening an editor on an error.
    const taskspace =
      taskspaceId && path && !(readonly && !staticFiles)
        ? (s.taskspaces.find(({ id }) => id === taskspaceId) ?? null)
        : null;

    const acted: string[] = [];
    if (taskspace && path) {
      editor.open(
        { fetcher: s.fetcher, projectId: s.projectId, staticFiles },
        { taskspaceId: taskspace.id, taskspaceName: taskspace.name, path },
      );
      acted.push("taskspace", "path");
    }
    if (card) {
      // Selected as well as centred, which is what says *which* card the tag matched: the
      // pan puts it in the middle of a board that may be dense, and the middle of the screen
      // is not a mark. The same thing `focusWarp` does for `?warp=`, in this page's other
      // vocabulary. Not in a read-only export, where nothing clears a selection again.
      if (!readonly) {
        s.selection.selectedCards = new Set([card.id]);
        s.selection.primarySelectedId = card.id;
      }
      acted.push("card");
    }
    if (acted.length > 0) clearQuery(...acted);

    // The pan is the one part that has to wait for the canvas to exist. It changes nothing on
    // the URL, so it is free to happen after the clear above.
    if (card) tick().then(() => canvasComponent.centerOn(card.posX, card.posY));
  }

  // Remember the layer being worked on, so a reload comes back to it instead of to Base.
  $effect(() => storeActiveLayerId(s.projectId, s.activeLayerId));

  // Resolved before the canvas mounts, so a page loaded with `?warp=` opens on the warp
  // instead of scrolling to it once the middle of the board has already been painted.
  const initialWarp = untrack(warpFromUrl);
  if (initialWarp) untrack(() => focusWarp(initialWarp.id));

  onMount(() => {
    if (initialWarp) clearQuery("warp");
    // After the warp landing above, so a link carrying both ends on the card it named.
    openFromUrl();
  });

  // Keep this long-lived page in sync with writes made by the CLI or another tab.
  // The snapshot endpoint returns the current database state; refreshFromData applies it
  // without resetting the user's current filters or selection.
  onMount(() => {
    // A static export has no /api/snapshot endpoint and no writers to sync with.
    if (readonly) return;
    return startSnapshotPoll({
      fetcher: s.fetcher,
      projectId: () => s.projectId,
      activities: [positionActivity, s.mutations],
      apply: (snapshot) => s.refreshFromData(snapshot),
      isHidden: () => document.visibilityState === "hidden",
    });
  });

  // ── Domain action handlers ────────────────────────────────────
  const actions = createProjectActions(s);

  // ── Composer submit (needs canvas ref for new card position) ──
  async function handleComposerSubmit(id: string | null, content: string, bundleId: string) {
    if (id) {
      const res = await updateCard(s.mutationFetcher, data.project.id, id, { content, bundleId });
      if (!res.ok) { s.setError("Failed to save card"); return; }
      s.cards = s.cards.map((c) => (c.id === id ? { ...c, content, bundleId } : c));
      s.selection.composerCard = null;
    } else {
      const { posX, posY } = canvasComponent.getNewCardPosition(newCardSeq++);
      const scopeId = s.sidebar.activeScope;
      const layerId = s.activeLayerId;
      // Only cards on the same layer compete for stacking, so the new card starts above them.
      const zIndex = maxZIndex(s.cards.filter((c) => c.layerId === layerId)) + 1;
      const res = await createCard(s.mutationFetcher, data.project.id, {
        bundleId,
        content,
        posX,
        posY,
        zIndex,
        ...(scopeId && { scopeId }),
        ...(layerId && { layerId }),
      });
      if (!res.ok) { s.setError("Failed to create card"); return; }
      const created: CardWithGlue | null = await res.json().catch(() => null);
      if (!created) { s.setError("Failed to create card"); return; }
      // The stored row, not a local reconstruction: the server clamps posX/posY to the
      // canvas, so a card composed at the edge would otherwise jump on the next poll.
      s.cards = [...s.cards, created];
      if (scopeId) s.scopeRels = [...s.scopeRels, { scopeId, cardId: created.id }];
    }
  }

  async function handlePersistPositions(positions: CardPositionPatch[]): Promise<boolean> {
    const res = await patchCardPositions(s.mutationFetcher, data.project.id, positions);
    return res.ok;
  }

  /** Shows the card's resize handle, or takes it away when it is the one already showing. */
  function handleResizeToggle(cardId: string) {
    s.selection.resizingCardId = s.selection.resizingCardId === cardId ? null : cardId;
  }

  /**
   * The canvas has already written the new width onto the card, the way a drag writes a
   * new position: this only saves it, and answers whether the save took, so the canvas can
   * put the old width back if it did not.
   */
  async function handlePersistWidth(cardId: string, width: number): Promise<boolean> {
    const res = await updateCard(s.mutationFetcher, data.project.id, cardId, { width });
    return res.ok;
  }

  async function handleStackOrderChange(cardId: string, direction: "front" | "back") {
    const card = s.cards.find((item) => item.id === cardId);
    if (!card) return;
    const previous = card.zIndex;
    // Stacking is relative to the card's own layer: layer order decides the rest.
    const layerCards = s.cards.filter((item) => item.layerId === card.layerId);
    const zIndex = direction === "front" ? maxZIndex(layerCards) + 1 : minZIndex(layerCards) - 1;
    s.cards = s.cards.map((item) => (item.id === cardId ? { ...item, zIndex } : item));
    const res = await updateCard(s.mutationFetcher, data.project.id, cardId, { zIndex });
    if (!res.ok) {
      s.cards = s.cards.map((item) =>
        item.id === cardId && item.zIndex === zIndex ? { ...item, zIndex: previous } : item,
      );
      s.setError("Failed to change card stacking order");
    }
  }

  /** Fills the palette in with warps another tab or the CLI has set since the page loaded. */
  async function refreshWarpDirectory() {
    // A static export has no endpoint to ask, and nothing can have changed under it.
    if (readonly) return;
    try {
      const res = await fetchWarpDirectory(s.fetcher, s.projectId);
      if (!res.ok) return;
      const parsed = parseWarpEntries(await res.json().catch(() => null));
      // An answer that is not a list of rows is treated as no answer at all.
      if (parsed) warpDirectory = parsed;
    } catch {
      // The copy that came with the page stays: a stale list beats an empty one.
    }
  }

  /**
   * Focuses a warp, revealing the markers if they were hidden. The remove key acts on the
   * focused warp, so a focus with nothing on screen to show for it is a warp that
   * disappears by surprise — the same reason setting a warp reveals them.
   */
  function focusWarp(warpId: string) {
    warpsVisible = true;
    s.focusedWarpId = warpId;
  }

  function handleWarpJump(entry: WarpListEntry) {
    warpPaletteOpen = false;
    if (entry.projectId === s.projectId) {
      canvasComponent.centerOn(entry.posX, entry.posY);
      focusWarp(entry.id);
      return;
    }
    // The other project's page decides where its own canvas opens, so the warp travels in
    // the URL rather than in memory — which also makes the jump a link worth sharing. The
    // trailing slash follows this page's own: a static export is built with one, and a
    // path missing it is redirected, which is a redirect the query would have to survive.
    const slash = page.url.pathname.endsWith("/") ? "/" : "";
    void goto(`${base}/${entry.projectId}${slash}?warp=${entry.id}`);
  }

  /**
   * Removing from the palette, which is the only way to reach another project's warps: the
   * `x` key only ever acts on the marker this board has focused.
   */
  async function handleWarpDelete(entry: WarpListEntry) {
    if (entry.projectId === s.projectId) {
      // Same path the `x` key takes, so one warp cannot be removed two different ways.
      await actions.handleRemoveWarp(entry.id);
      return;
    }
    const previous = warpDirectory;
    warpDirectory = withoutWarp(warpDirectory, entry.id);
    const res = await deleteWarp(s.mutationFetcher, entry.projectId, entry.id);
    if (!res.ok) {
      warpDirectory = previous;
      s.setError(await failureMessage(res, "Failed to remove warp"));
    }
  }

  /**
   * The warps an arrow key may still travel to: all of them, less the focused one once the
   * view has arrived on it. A warp within half a viewport of the canvas edge cannot be
   * brought to the middle of the view, so it goes on reading as lying ahead after the jump
   * has landed — and pressing the same arrow again would keep choosing it instead of
   * wrapping round the board. Dropping it only once the view is as centred on it as the
   * board allows leaves the ordinary case alone: pan away from a warp and it is a
   * destination again.
   */
  function reachableWarps() {
    const focused = s.warps.find(({ id }) => id === s.focusedWarpId);
    return focused && canvasComponent.isCenteredOn(focused.posX, focused.posY)
      ? s.warps.filter(({ id }) => id !== focused.id)
      : s.warps;
  }

  function handleKeydown(e: KeyboardEvent) {
    // The palette owns the keyboard while it is open, including the key that closes it.
    if (warpPaletteOpen) return;
    // So does the editor. Its own handler stops propagation, but a click on the panel
    // chrome — a button rather than the text — leaves focus somewhere that does not, and
    // the board must not act on a key aimed at an open file.
    if (editor.isOpen) return;
    // A held key repeats around thirty times a second, and every shortcut below is a
    // discrete command rather than something to hold: without this, resting on the
    // set-warp key drops a warp per repeat — each one a POST and a marker stacked on the
    // last, with only the topmost reachable to remove.
    if (e.repeat) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
    // Shortcuts are single keys, and `event.key` carries no modifier but Shift: without
    // this, Ctrl/Cmd+A — select-all — reads as the set-warp key and drops a warp, and the
    // browser's own Ctrl/Cmd shortcuts each collide with whatever letter matches them.
    // Shift is the exception: it is part of the palette's own chord, and a shortcut may be
    // configured as a capital letter (`toggleWarpsShortcut` is Shift+A by default).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!readonly && e.key === data.uiConfig.focusCardInputShortcut) {
      e.preventDefault();
      s.selection.composerCard = null;
      s.selection.selectedCards = new Set();
      s.selection.primarySelectedId = null;
      tick().then(() => composerComponent.focusInput());
      return;
    }
    // Below this line the composer's action bar owns the keyboard whenever cards are
    // selected, which is what keeps the warp keys from colliding with it.
    if (s.selection.selectedCards.size > 0) return;
    // One key, one action: each branch returns, so a config that binds two shortcuts to
    // the same key does one thing rather than both. `kozane doctor config` warns about
    // such a binding, but the config is still loaded and the page still has to behave.
    if (e.key === data.uiConfig.toggleFootersShortcut) {
      showFooters = !showFooters;
      return;
    }
    if (e.key === data.uiConfig.togglePanelsShortcut) {
      sidebarsVisible = !sidebarsVisible;
      return;
    }
    if (e.key === data.uiConfig.toggleWarpsShortcut) {
      warpsVisible = !warpsVisible;
      return;
    }

    const direction = ARROW_DIRECTIONS[e.key];
    if (direction && e.shiftKey) {
      // Any of the four arrows opens the same list: the direction is how the hand already
      // reaches for warping, not a choice of which warps to show.
      e.preventDefault();
      warpPaletteOpen = true;
      void refreshWarpDirectory();
      return;
    }
    if (direction) {
      // Measured from where the view is now, so warping works the same whether you
      // arrived by arrow key or by dragging the canvas.
      const { posX, posY } = canvasComponent.getViewCenter();
      const target = warpInDirection(
        reachableWarps(),
        { x: posX, y: posY },
        direction,
        s.focusedWarpId,
      );
      if (target) {
        e.preventDefault();
        canvasComponent.centerOn(target.posX, target.posY);
        focusWarp(target.id);
      }
      return;
    }
    if (readonly) return;
    if (e.key === data.uiConfig.setWarpShortcut) {
      // A warp you cannot see is a warp you cannot remove, so setting one reveals them.
      warpsVisible = true;
      void actions.handleSetWarp(canvasComponent.getWarpPosition());
      return;
    }
    if (e.key === data.uiConfig.removeWarpShortcut && s.focusedWarpId) {
      void actions.handleRemoveWarp(s.focusedWarpId);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class={css({ display: "flex", height: "100vh", overflow: "hidden", backgroundColor: "ink.lighter" })}>
  <BundleSidebar
    visible={sidebarsVisible}
    panelWidth={data.uiConfig.leftPanelWidth}
    cards={s.cards}
    bundles={bundlesWithColors}
    bind:activeBundle={s.sidebar.activeBundle}
    bind:newBundleName={s.sidebar.newBundleName}
    onCreateBundle={actions.handleCreateBundle}
    onDeleteBundle={actions.handleDeleteBundle}
    {readonly}
  />

  <div class={css({ flex: "1", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" })}>
    <KozaneCanvas
      bind:this={canvasComponent}
      bind:cards={s.cards}
      {visibleCards}
      glueRels={s.glueRels}
      layers={s.layers}
      activeLayerId={s.activeLayerId}
      {bundleColorById}
      selection={s.selection}
      {scopeCardIds}
      warps={s.warps}
      focusedWarpId={s.focusedWarpId}
      {warpsVisible}
      warpMarkerSize={data.uiConfig.warpMarkerSize}
      initialCenter={initialWarp && { posX: initialWarp.posX, posY: initialWarp.posY }}
      onFocusWarp={focusWarp}
      {showFooters}
      bind:zoom
      zoomStep={data.uiConfig.zoomStep}
      canvasWidth={data.uiConfig.canvasWidth}
      canvasHeight={data.uiConfig.canvasHeight}
      cardWidth={data.uiConfig.defaultCardWidth}
      newCardPlacement={data.uiConfig.newCardPlacement}
      fontSize={data.uiConfig.defaultFontSize}
      fontFamily={data.uiConfig.defaultFontFamily}
      onPersistPositions={handlePersistPositions}
      onPersistWidth={handlePersistWidth}
      onPositionActivityStart={() => positionActivity.begin()}
      onPositionActivityEnd={() => positionActivity.end()}
      onError={(msg) => (s.lastError = msg)}
      tagHref={(tag) =>
        `${base}/tags?projectId=${data.project.id}&tag=${encodeURIComponent(tag)}`}
      {readonly}
    />

    {#if warpPaletteOpen}
      <WarpPalette
        entries={warpEntries}
        focusedWarpId={s.focusedWarpId}
        {readonly}
        onJump={handleWarpJump}
        onDelete={handleWarpDelete}
        onClose={() => (warpPaletteOpen = false)}
      />
    {/if}

    {#if s.lastError}
      <ErrorBanner message={s.lastError} onDismiss={() => (s.lastError = null)} />
    {/if}

    <LayerControl
      layers={s.layers}
      cards={s.cards}
      bind:activeLayerId={s.activeLayerId}
      onCreateLayer={actions.handleCreateLayer}
      onDeleteLayer={actions.handleDeleteLayer}
      onRenameLayer={actions.handleRenameLayer}
      onReorderLayers={actions.handleReorderLayers}
      {readonly}
    />

    <ScopeControl scopes={s.scopes} bind:activeScope={s.sidebar.activeScope} />

    <FloatingControls
      {zoom}
      zoomStep={data.uiConfig.zoomStep}
      {sidebarsVisible}
      onToggleSidebars={() => (sidebarsVisible = !sidebarsVisible)}
      onZoom={(delta) => (zoom = clampZoom(zoom + delta))}
    />

    {#if !readonly}
    <FloatingComposer
      bind:this={composerComponent}
      editingCard={s.selection.composerCard}
      selectedCards={selectedCardObjects}
      {selectionGlueRels}
      {primaryCard}
      bundles={bundlesWithColors}
      {defaultBundleId}
      layers={s.layers}
      onSubmit={handleComposerSubmit}
      onCancel={() => { s.selection.composerCard = null; s.selection.selectedCards = new Set(); s.selection.primarySelectedId = null; }}
      onBundleChange={actions.handleCardBundleChange}
      onSelectionBundleChange={actions.handleSelectionBundleChange}
      onGlueSelected={actions.handleGlueSelected}
      onUnglueSelected={actions.handleUnglueSelected}
      onUnglueOne={actions.handleUnglueOne}
      onDeleteSelected={actions.handleDeleteSelected}
      otherProjects={data.otherProjects}
      onMoveToProject={actions.handleMoveSelectionToProject}
      onSelectionLayerChange={actions.handleSelectionLayerChange}
      onStackOrderChange={handleStackOrderChange}
      onResizeToggle={handleResizeToggle}
      onSquashCard={actions.handleSquashCard}
      resizingCardId={s.selection.resizingCardId}
      shortcuts={data.uiConfig}
    />
    {/if}
  </div>

  <ScopeSidebar
    visible={sidebarsVisible}
    panelWidth={data.uiConfig.rightPanelWidth}
    scopes={s.scopes}
    scopeRels={s.scopeRels}
    taskspaces={s.taskspaces}
    taskspaceTree={s.taskspaceTree}
    treeContext={{ fetcher: s.fetcher, projectId: s.projectId, staticFiles }}
    selectedCards={s.selection.selectedCards}
    bind:activeScope={s.sidebar.activeScope}
    bind:newScopeName={s.sidebar.newScopeName}
    bind:newWcName={s.sidebar.newWcName}
    onCreateScope={actions.handleCreateScope}
    onDeleteScope={actions.handleDeleteScope}
    onAddToScope={actions.handleAddToScope}
    onRemoveFromScope={actions.handleRemoveFromScope}
    onCreateTaskspace={actions.handleCreateTaskspace}
    onOpenFile={!readonly || staticFiles
      ? (taskspaceId, taskspaceName, path) =>
          editor.open(
            { fetcher: s.fetcher, projectId: s.projectId, staticFiles },
            { taskspaceId, taskspaceName, path },
          )
      : undefined}
    {readonly}
  />

  <FileEditor
    session={editor}
    ctx={{ fetcher: s.fetcher, projectId: s.projectId, staticFiles }}
    vimMode={data.uiConfig.editorVimMode}
    {readonly}
    bind:width={editorWidth}
    onClose={() => undefined}
  />
</div>
