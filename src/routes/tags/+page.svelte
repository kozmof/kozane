<script lang="ts">
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import NavIcon from "$lib/components/NavIcon.svelte";
  import {
    buildTagTree,
    capHitsByKind,
    groupHitRows,
    groupHitsByTaskspace,
    normalizeTag,
    tagMatcher,
    tagMatches,
    truncationReasons,
    truncationPaths,
    missingTaskspaceLabel,
    cleanupCommandTail,
    CARDS_TRUNCATED_LABEL,
    TASKSPACE_CLEANUP_COMMAND,
    type TagCounts,
    type TagNode,
  } from "$lib/tag";
  import { TAG_HITS_SHOWN_MAX } from "$lib/constants";
  import type { TagHit } from "$lib/types";
  import TagResults from "./components/TagResults.svelte";
  import { activeRowClass, countClass, noteClass, rowClass } from "./lib/styles.js";

  let { data }: PageProps = $props();

  /** Use server query data for live pages and browser URL filters for static exports. */
  const selectedTag = $derived.by(() => {
    if (data.tag) return data.tag;
    if (!browser) return null;
    const requested = page.url.searchParams.get("tag");
    return requested ? normalizeTag(requested) : null;
  });

  /** Use null to gather the whole workspace when `?namespaceId=` is absent. */
  const selectedNamespaceId = $derived(
    data.namespaceId ?? (browser ? page.url.searchParams.get("namespaceId") : null),
  );

  const selectedNamespace = $derived(
    data.namespaces.find(({ id }) => id === selectedNamespaceId) ?? null,
  );

  /**
   * Match the board's namespace visibility rules. Cards belong to their partition's
   * namespace, while unplaced taskspaces appear in every namespace.
   */
  function inSelectedNamespace(hit: TagHit): boolean {
    if (!selectedNamespaceId) return true;
    if (hit.source.kind === "card") return data.cardNamespaces[hit.source.cardId] === selectedNamespaceId;
    const owner = data.taskspaces[hit.source.taskspaceId]?.namespaceId;
    return owner === selectedNamespaceId || owner === null;
  }

  /**
   * Filter and cap hits per kind in one pass with the shared server helper. Live results are
   * already filtered, while static exports contain the full gathered dataset.
   */
  const shown = $derived.by(() => {
    if (!selectedTag) return capHitsByKind<TagHit>([], TAG_HITS_SHOWN_MAX);
    const matches = tagMatcher(selectedTag);
    return capHitsByKind(
      data.hits,
      TAG_HITS_SHOWN_MAX,
      (hit) => matches(hit.tag) && inSelectedNamespace(hit),
    );
  });
  const shownCount = $derived(shown.cards.length + shown.files.length);

  /** Use server totals for live results and locally filtered totals for exports. */
  const cardTotal = $derived(data.cardTotal ?? shown.cardTotal);
  const fileTotal = $derived(data.fileTotal ?? shown.fileTotal);

  /**
   * Report omitted hits separately for cards and files. Count hits rather than grouped rows
   * or distinct sources because display caps apply before grouping.
   */
  const cappedNotice = $derived.by(() => {
    const parts = [];
    if (shown.cards.length < cardTotal)
      parts.push(`${shown.cards.length} of ${cardTotal} card hits`);
    if (shown.files.length < fileTotal)
      parts.push(`${shown.files.length} of ${fileTotal} file hits`);
    return parts.length > 0
      ? `Showing the first ${parts.join(", and the first ")}. Narrow with a subcategory to see the rest.`
      : null;
  });

  /**
   * Filter the exported tree with the panel so tag counts match selectable results. Live
   * responses are already filtered by namespace.
   */
  const narrowsNamespace = $derived(selectedNamespaceId !== null && data.namespaceId === null);
  const tree = $derived(
    narrowsNamespace ? buildTagTree(data.hits.filter(inSelectedNamespace)) : data.tree,
  );

  /**
   * Group hits into one row per card with the shared CLI helper `groupHitRows`.
   * A card containing both `:perf:cache` and `:perf` still appears once for `:perf`.
   */
  const cardRows = $derived(groupHitRows(shown.cards));

  /** Group file hits by taskspace and then by line through the shared CLI and browser helper. */
  const fileRowsByTaskspace = $derived(groupHitsByTaskspace(shown.files));

  /**
   * Index namespace names once for row lookups. Taskspace metadata already arrives keyed by
   * ID.
   */
  const namespaceNames = $derived(new Map(data.namespaces.map(({ id, name }) => [id, name])));

  const taskspaceName = (id: string) => data.taskspaces[id]?.name || "taskspace";
  const namespaceName = (id: string | null | undefined) =>
    (id !== null && id !== undefined ? namespaceNames.get(id) : undefined) ?? "";

  /** Unavailable taskspaces. Older exports may omit this list. */
  const missing = $derived(data.missing ?? []);

  /** Open unplaced taskspace files on the workspace's default board. */
  const defaultNamespaceId = $derived(
    data.namespaces.find(({ isDefault }) => isDefault)?.id ?? data.namespaces[0]?.id ?? null,
  );

  /**
   * Preserve `?namespaceId=` across tag links. Namespace and tag parameters are independent
   * and optional.
   */
  const tagHref = (tag: string) => {
    const params = new URLSearchParams();
    if (selectedNamespaceId) params.set("namespaceId", selectedNamespaceId);
    params.set("tag", tag);
    return `${base}/tags?${params}`;
  };
  const namespaceHref = (namespaceId: string | null) => {
    const params = new URLSearchParams();
    if (namespaceId) params.set("namespaceId", namespaceId);
    if (selectedTag) params.set("tag", selectedTag);
    const query = params.toString();
    return query ? `${base}/tags?${query}` : `${base}/tags`;
  };

  /**
   * Resolve a destination board from a card's namespace or a file's taskspace. For unplaced
   * taskspaces, fall back to the selected namespace and then the default. Return null if no
   * board can be identified.
   */
  const cardHref = (cardId: string) => {
    const namespaceId = data.cardNamespaces[cardId];
    return namespaceId ? `${base}/${namespaceId}?card=${cardId}` : null;
  };
  const fileHref = (taskspaceId: string, path: string) => {
    const namespaceId =
      data.taskspaces[taskspaceId]?.namespaceId ?? selectedNamespaceId ?? defaultNamespaceId;
    return namespaceId
      ? `${base}/${namespaceId}?taskspace=${taskspaceId}&path=${encodeURIComponent(path)}`
      : null;
  };

  /** Expand ancestors of the selected tag so direct links reveal it in the tree. */
  const isOpen = (node: TagNode) => !!selectedTag && tagMatches(node.tag, selectedTag);

  /** Display the combined card and file count for each tag. */
  const countLabel = ({ cards, files }: TagCounts) => `${cards + files}`;

  /**
   * Provide an accessible count naming each kind, such as `1 card, 2 files`, so the row can
   * be understood without the adjacent results panel.
   */
  const countDescription = ({ cards, files }: TagCounts) =>
    [
      cards ? `${cards} card${cards === 1 ? "" : "s"}` : "",
      files ? `${files} file${files === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(", ");

</script>

<svelte:head>
  <title>{selectedNamespace ? `Tags · ${selectedNamespace.name}` : "Tags"}</title>
</svelte:head>


{#snippet branch(nodes: TagNode[], depth: number)}
  <ul class={css({ listStyle: "none", margin: "0", padding: "0" })}>
    {#each nodes as node (node.tag)}
      <li>
        <!-- Use `aria-current` to expose the selected tag to screen readers as well as marking it visually. -->
        <a
          href={tagHref(node.tag)}
          aria-current={selectedTag === node.tag ? "page" : undefined}
          style="padding-left: {8 + depth * 14}px"
          class="{rowClass} {selectedTag === node.tag ? activeRowClass : ''}"
        >
          <span class={css({ fontFamily: "mono" })}>{node.name}</span>
          <!-- Add a screen-reader label identifying the count while keeping the visible
               number compact. -->
          <span class={countClass} aria-hidden="true">{countLabel(node.total)}</span>
          <span class={css({ srOnly: true })}>{countDescription(node.total)}</span>
        </a>
        {#if node.children.length > 0 && (depth === 0 || isOpen(node))}
          {@render branch(node.children, depth + 1)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<main
  class={css({
    padding: "32px 48px 64px",
    backgroundColor: "ink.lighter",
    minHeight: "100vh",
  })}
>
  <header
    class={css({
      marginBottom: "24px",
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      gap: "6px 14px",
      fontSize: "12px",
      fontFamily: "mono",
    })}
  >
    <!-- Label the back destination explicitly, whether it is the namespace list or a selected board. -->
    <a
      href="{base}/{selectedNamespaceId ?? ''}"
      title={selectedNamespace ? undefined : "Namespaces"}
      aria-label={selectedNamespace ? `Back to ${selectedNamespace.name}` : "All namespaces"}
      class={css({
        display: "flex",
        alignItems: "center",
        // The gap separates the icon and label and takes no space when the link has only an icon.
        gap: "6px",
        padding: "6px",
        borderRadius: "2px",
        // Use a darker color for the small text label to keep it readable beside the icon.
        // Darken both on hover.
        color: "neutral.iconDim",
        textDecoration: "none",
        "& span": { color: "neutral.muted" },
        _hover: {
          color: "ink.black",
          backgroundColor: "neutral.border",
          "& span": { color: "ink.black" },
        },
      })}
    >
      <NavIcon kind="namespaces" />
      {#if selectedNamespace}
        <span>{selectedNamespace.name}</span>
      {/if}
    </a>

    <!-- Select a namespace to filter the index. Select it again to show the whole workspace. -->
    <nav
      aria-label="Scope"
      class={css({ display: "flex", flexWrap: "wrap", gap: "10px", marginLeft: "auto" })}
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

  {#if tree.length !== 0}
    <div
      class={css({
        display: "grid",
        gridTemplateColumns: { base: "1fr", md: "minmax(200px, 280px) 1fr" },
        gap: "32px",
        alignItems: "start",
      })}
    >
      <nav aria-label="Tags">
        {@render branch(tree, 0)}
      </nav>

      <section>
        {#if !selectedTag}
          <p class={css({ color: "neutral.subtle", fontSize: "13px" })}>
            Pick a tag to see what it gathers. A tag gathers its subcategories too, so
            <code class={css({ fontFamily: "mono" })}>:foo</code> holds everything under
            <code class={css({ fontFamily: "mono" })}>:foo:bar</code>.
          </p>
        {:else}
          <TagResults
            {data}
            {selectedTag}
            {selectedNamespaceId}
            {shownCount}
            {cappedNotice}
            {cardRows}
            {fileRowsByTaskspace}
            {namespaceName}
            {taskspaceName}
            {cardHref}
            {fileHref}
          />
        {/if}

        <!-- Show card truncation before file warnings using the shared CLI label. -->
        {#if data.cardsTruncated}
          <p class={noteClass}>
            The cards were not read in full — {CARDS_TRUNCATED_LABEL}, so a tag written on one
            may be missing here.
          </p>
        {/if}

        <!-- Use gathered taskspace names and shared reader-facing reasons and path samples. -->
        {#each data.truncated as { taskspaceId, reasons, paths } (taskspaceId)}
          <p class={noteClass}>
            {taskspaceName(taskspaceId)} was not read in full — {truncationReasons(reasons)}{truncationPaths(
              paths,
            )}, so a tag written in it may be missing here.
          </p>
        {/each}

        <!-- Report unavailable roots separately from partial scans. Use shared wording and format the repair command for the page. Treat absent lists from older exports as empty. -->
        {#each missing as taskspaceId (taskspaceId)}
          <p class={noteClass}>{missingTaskspaceLabel(taskspaceName(taskspaceId))}.</p>
        {/each}
        {#if missing.length > 0}
          <!-- Show the command once below all affected records. -->
          <p class={noteClass}>
            Run <code class={css({ fontFamily: "mono" })}>{TASKSPACE_CLEANUP_COMMAND}</code>
            {cleanupCommandTail(missing.length)}
          </p>
        {/if}
      </section>
    </div>
  {/if}
</main>
