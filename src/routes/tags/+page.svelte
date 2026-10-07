<script lang="ts">
  import type { PageProps } from "./$types";
  import type { Snippet } from "svelte";
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
    taggedWith,
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

  let { data }: PageProps = $props();

  /** Use server query data for live pages and browser URL filters for static exports. */
  const selectedTag = $derived.by(() => {
    if (data.tag) return data.tag;
    if (!browser) return null;
    const requested = page.url.searchParams.get("tag");
    return requested ? normalizeTag(requested) : null;
  });

  /** Null gathers the whole workspace, which is what this page does with no `?namespaceId=`. */
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
   * One row per card, not per hit. A card written `:perf:cache and :perf` matches a search
   * for `:perf` twice, and two rows would read as two cards. What counts as a row is
   * `groupHitRows` in `$lib/tag`, which the terminal groups by too.
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

  /** The taskspaces the gather could not open, or none from an export built before the page
   *  said anything about them. See where they are drawn, at the foot of the hits. */
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

  /** A node is open while the selected tag is inside it, so arriving on `:foo:bar:baz` by
   *  link opens the tree down to it rather than showing a collapsed root. */
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

  const rowClass = css({
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    padding: "3px 8px",
    borderRadius: "2px",
    color: "ink.black",
    textDecoration: "none",
    fontSize: "13px",
    _hover: { backgroundColor: "neutral.bg" },
  });
  const activeRowClass = css({ backgroundColor: "neutral.bg", fontWeight: "600" });
  const countClass = css({ fontSize: "10.5px", color: "neutral.subtle", fontFamily: "mono" });
  /** Taskspace heading that identifies the base directory for relative file paths. */
  const taskspaceHeadingClass = css({
    fontSize: "11px",
    fontWeight: "400",
    fontFamily: "mono",
    color: "neutral.muted",
    marginBottom: "6px",
  });
  /**
   * Render card text and matching file excerpts as primary content, with quieter surrounding
   * metadata.
   */
  const excerptClass = css({
    fontSize: "12.5px",
    color: "ink.black",
    fontFamily: "mono",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  });

  /**
   * Use consistent secondary styling for card truncation, partial taskspace scans, and
   * unavailable taskspaces.
   */
  const noteClass = css({ fontSize: "12px", color: "neutral.subtle", marginTop: "8px" });

  /**
   * Apply link styling only to rows with destinations. Render rows without a board as plain
   * elements so hover and pointer cues do not imply an unavailable action.
   */
  const linkableRowClass = css({
    textDecoration: "none",
    transition: "border-color 0.1s",
    _hover: { borderColor: "neutral.muted" },
  });
  const rowSurface = {
    background: "ink.white",
    border: "1px solid token(colors.neutral.border)",
    borderRadius: "2px",
  } as const;
  const cardRowClass = css({ ...rowSurface, display: "block", padding: "10px 14px" });
  const fileRowClass = css({
    ...rowSurface,
    display: "flex",
    gap: "12px",
    alignItems: "baseline",
    padding: "6px 14px",
  });
</script>

<svelte:head>
  <title>{selectedNamespace ? `Tags · ${selectedNamespace.name}` : "Tags"}</title>
</svelte:head>

{#snippet hitRow(href: string | null, shape: string, body: Snippet)}
  {#if href}
    <a {href} class="{shape} {linkableRowClass}">{@render body()}</a>
  {:else}
    <!-- Show the result without link behavior when no destination board exists. -->
    <div class={shape}>{@render body()}</div>
  {/if}
{/snippet}

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
          <!-- The number is drawn bare, which reads as "perf 12" with nothing to say what
               12 is. The unit is given to a reader that cannot see the column it sits in,
               and hidden from one that can. -->
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
        // Only ever between the icon and a name, so it costs nothing on the icon-only link.
        gap: "6px",
        padding: "6px",
        borderRadius: "2px",
        // An icon's weight, and a label's for the name beside it: the two are not the same
        // kind of mark, and a name drawn as light as the picture is hard to read at the size
        // a header sets. Both darken together on hover, or half the link would light up.
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

    <!-- Which namespace the index is narrowed to, and the way to change it. Picking the
         namespace already selected clears the narrowing, which is the way back to the whole
         workspace now that it has no row of its own. -->
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
          <h2 class={css({ fontSize: "15px", fontFamily: "mono", marginBottom: "16px" })}>
            '{selectedTag}
          </h2>

          {#if shownCount === 0}
            <p class={css({ color: "neutral.subtle", fontSize: "13px" })}>Nothing under this tag.</p>
          {:else if cappedNotice}
            <p
              class={css({ color: "neutral.subtle", fontSize: "12px", marginBottom: "12px" })}
            >
              {cappedNotice}
            </p>
          {/if}

          {#if cardRows.length > 0}
            <ul
              class={css({
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                marginBottom: "28px",
              })}
            >
              {#each cardRows as { key, source, hits } (key)}
                {@const cardId = source.cardId}
                <!-- Guard both optional lookups before reading partition metadata. -->
                {@const partitionId = data.cardPartitionIds[cardId]}
                {@const partition = partitionId ? data.partitions[partitionId] : undefined}
                <li>
                  {#snippet cardBody()}
                    <span class={excerptClass}>{hits[0].excerpt}</span>
                    <span
                      class={css({
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        marginTop: "8px",
                        fontSize: "11px",
                        color: "neutral.subtle",
                      })}
                    >
                      {#if partition}
                        <span
                          style="background: {partition.dot}"
                          class={css({ width: "8px", height: "8px", borderRadius: "999px" })}
                        ></span>
                        {partition.name}
                      {/if}
                      <!-- Only when gathering across the workspace, where which board a card
                           is on is the thing a row cannot otherwise say. -->
                      {#if !selectedNamespaceId}
                        <span>{namespaceName(data.cardNamespaces[cardId])}</span>
                      {/if}
                      <span class={css({ fontFamily: "mono" })}>{taggedWith(hits).join(" ")}</span>
                    </span>
                  {/snippet}
                  {@render hitRow(cardHref(cardId), cardRowClass, cardBody)}
                </li>
              {/each}
            </ul>
          {/if}

          {#each fileRowsByTaskspace as { taskspaceId, rows } (taskspaceId)}
            <!-- Show the taskspace name to distinguish identical relative paths in different taskspaces. -->
            <h3 class={taskspaceHeadingClass}>{taskspaceName(taskspaceId)}</h3>
            <ul
              class={css({
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                marginBottom: "28px",
              })}
            >
              {#each rows as { key, source, hits } (key)}
                <li>
                  {#snippet fileBody()}
                    <span
                      class={css({
                        fontFamily: "mono",
                        fontSize: "11.5px",
                        color: "neutral.muted",
                        flexShrink: "0",
                      })}
                    >
                      {source.path}:{source.line}
                    </span>
                    <span class={excerptClass}>{hits[0].excerpt}</span>
                  {/snippet}
                  {@render hitRow(fileHref(taskspaceId, source.path), fileRowClass, fileBody)}
                </li>
              {/each}
            </ul>
          {/each}
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
