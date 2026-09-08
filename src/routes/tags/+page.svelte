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

  /**
   * What the URL asks for. `data.*` on the live page, where the server read the query and
   * narrowed against it; from the URL in a static export, which is prerendered and so has no
   * query at build time. Either way one value, so everything below reads the same on both.
   */
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
   * Whether a hit belongs to the selected namespace. The same rule the board draws by: a card
   * belongs to the namespace its partition does, and a taskspace to its own namespace *or* to none
   * at all — an unplaced taskspace appears on every board, so it belongs to every namespace's
   * index too.
   */
  function inSelectedNamespace(hit: TagHit): boolean {
    if (!selectedNamespaceId) return true;
    if (hit.source.kind === "card") return data.cardNamespaces[hit.source.cardId] === selectedNamespaceId;
    const owner = data.taskspaces[hit.source.taskspaceId]?.namespaceId;
    return owner === selectedNamespaceId || owner === null;
  }

  /**
   * Selected and capped in one pass, by the same function and to the same number the server
   * caps by, so an export and the live page list alike.
   *
   * The selection is a no-op on the live page — the server sent exactly this set — and is the
   * real one in a static export, where every hit of every namespace was baked in. One path
   * rather than a branch that only one of the two ever takes.
   *
   * Handed to `capHitsByKind` rather than run as a `filter` before it, so an export holding
   * the whole workspace's hits does not copy everything one tag matched in order to draw two
   * hundred rows of each kind. Per kind, which matters here for the same reason it matters on
   * the server: the hits arrive cards first, so one ceiling across both would let a much-used
   * tag's cards push its files off the page entirely.
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

  /** What each list below is a part of. The server counted before capping; in an export
   *  nothing was capped before the filter just above, so the counts are taken from that. */
  const cardTotal = $derived(data.cardTotal ?? shown.cardTotal);
  const fileTotal = $derived(data.fileTotal ?? shown.fileTotal);

  /**
   * What is not being shown, said per kind, or nothing when everything is.
   *
   * The tree's count is of the whole thing, so a cut list has to say it is one or the two
   * numbers read as a disagreement. Per kind because the caps are: "the first 200 of 900"
   * over a list that also holds files would be a second disagreement in place of the first.
   *
   * Counted in *hits*, and said so — the word is what makes the number true rather than a
   * third disagreement. The cap is applied before `groupHitRows`, so a card carrying `'perf`
   * and `'perf:cache` is two of what is counted here, one row below, and one card in the
   * tree beside it; calling that "cards" made the notice contradict both. `kozane tag show`
   * says "card hits" for exactly this reason, and now says it in the same words.
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
   * The tree, narrowed the same way the panel is, so the count beside a tag is a count of
   * what selecting it would list.
   *
   * Only a static export ever has anything to narrow: the live server already built the tree
   * from the namespace it was asked about, so on that path this is false and the tree it sent
   * is already the right one.
   */
  const narrowsNamespace = $derived(selectedNamespaceId !== null && data.namespaceId === null);
  const tree = $derived(
    narrowsNamespace ? buildTagTree(data.hits.filter(inSelectedNamespace)) : data.tree,
  );

  /**
   * One row per card, not per hit. A card written `'perf:cache and 'perf` matches a search
   * for `'perf` twice, and two rows would read as two cards. What counts as a row is
   * `groupHitRows` in `$lib/tag`, which the terminal groups by too.
   */
  const cardRows = $derived(groupHitRows(shown.cards));

  /** File hits gathered under the taskspace they were found in, so a path is read against
   *  the directory it is relative to rather than on its own — and within that, one row per
   *  line, since each is somewhere to go and look. `groupHitsByTaskspace` in `$lib/tag`,
   *  which `kozane tag show` heads its file rows with too. */
  const fileRowsByTaskspace = $derived(groupHitsByTaskspace(shown.files));

  /**
   * Namespace names by id, built once rather than searched per row. It was a linear `find`
   * called from inside an `{#each}`, so drawing a tag with two hundred cards on it walked the
   * namespace list two hundred times. Nothing anyone would have measured at this size; it is a
   * shape worth not having on the page that exists to draw a lot of rows at once.
   *
   * Taskspaces need no map of their own: the loader sends them as a record already keyed by
   * id, which is what `TagIndex.taskspaces` is.
   */
  const namespaceNames = $derived(new Map(data.namespaces.map(({ id, name }) => [id, name])));

  const taskspaceName = (id: string) => data.taskspaces[id]?.name || "taskspace";
  const namespaceName = (id: string | null | undefined) =>
    (id !== null && id !== undefined ? namespaceNames.get(id) : undefined) ?? "";

  /** The taskspaces the gather could not open, or none from an export built before the page
   *  said anything about them. See where they are drawn, at the foot of the hits. */
  const missing = $derived(data.missing ?? []);

  /** The workspace default, which is where an unplaced taskspace's file is opened: it is on
   *  every board, so no one of them is more its own than another. */
  const defaultNamespaceId = $derived(
    data.namespaces.find(({ isDefault }) => isDefault)?.id ?? data.namespaces[0]?.id ?? null,
  );

  /** `?namespaceId=` is kept across tag links, so narrowing to a namespace survives browsing the
   *  tree. Both parameters are optional and independent: either, both, or neither. */
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
   * A board link needs a board. A card names its own namespace; a file names its taskspace's,
   * falling back to the selected one and then to the default for an unplaced taskspace.
   *
   * Null where there is no board to name, and the card case can reach that too — the loader
   * takes the same care over this lookup, because `Record<string, string>` says it cannot
   * miss when it can. A card whose namespace is not among the data drew `/undefined?card=…`,
   * which is a row that looks right and goes nowhere.
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

  /** A node is open while the selected tag is inside it, so arriving on `'foo:bar:baz` by
   *  link opens the tree down to it rather than showing a collapsed root. */
  const isOpen = (node: TagNode) => !!selectedTag && tagMatches(node.tag, selectedTag);

  /** One number: what selecting this tag would put in the panel. Cards and files were drawn
   *  apart, which left the question the tree is actually read for — how much is under this
   *  tag — as a sum for the reader to do. Which kind each hit is, the panel says row by row. */
  const countLabel = ({ cards, files }: TagCounts) => `${cards + files}`;

  /**
   * The same count in words, for a reader who cannot see the column it is drawn in.
   *
   * Spelled out per kind rather than as the bare sum above, because the two audiences are in
   * different positions: the column is read down and its unit is obvious from the panel
   * beside it, while a row read aloud is read alone. That is the same judgement
   * `countLabel` in `cli/commands/tag.ts` makes for the terminal, and it lands on the same
   * wording — `1 card, 2 files` — because it is the same question about the same counts.
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
  /** The taskspace a group of file rows was found in. Quiet, like the rest of the metadata
   *  around a hit — it says what the paths beneath it are relative to, and nothing more. */
  const taskspaceHeadingClass = css({
    fontSize: "11px",
    fontWeight: "400",
    fontFamily: "mono",
    color: "neutral.muted",
    marginBottom: "6px",
  });
  /** The card's own text, and the line a file's tag sits on. It is what the panel is for, so
   *  it is drawn in the colour body text is drawn in everywhere else — the surrounding
   *  metadata is what stays quiet. */
  const excerptClass = css({
    fontSize: "12.5px",
    color: "ink.black",
    fontFamily: "mono",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  });

  /** Everything the gather has to say about what it could not read, in one voice: the cards'
   *  ceiling, a taskspace read in part, and a taskspace not read at all. Quieter than a row,
   *  because none of it is what the reader came for — and all of it is the same aside, so
   *  none of it should look more urgent than the rest. */
  const noteClass = css({ fontSize: "12px", color: "neutral.subtle", marginTop: "8px" });

  /**
   * The two row shapes, and the part that is only true of a row you can follow.
   *
   * Split because a row does not always have somewhere to go: `cardHref` and `fileHref` both
   * return null where the data names no board, and an `<a>` given no `href` is not a link —
   * it cannot be focused, clicked, or reached from the keyboard. Drawn as one anyway, it kept
   * the border that lifts on hover and the pointer that goes with it, so the only rows on the
   * page that do nothing were also the ones that most looked like they would.
   *
   * So the hover lift lives here, on the shape that is actually a link, and a row without a
   * destination is drawn as a plain `<div>` that says what it found and stays still.
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
    <!-- No board to send this row to — see `cardHref` and `fileHref`. It still says what was
         found, which is the half of a row that does not depend on being able to follow it. -->
    <div class={shape}>{@render body()}</div>
  {/if}
{/snippet}

{#snippet branch(nodes: TagNode[], depth: number)}
  <ul class={css({ listStyle: "none", margin: "0", padding: "0" })}>
    {#each nodes as node (node.tag)}
      <li>
        <!-- `aria-current` rather than the weight and background alone, which is the whole
             of what said "this one" before: a screen reader was given a tree of identical
             rows, and the namespace nav in the header above marks its selection this way
             already. -->
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
    <!-- Back to the namespace list, or to one namespace's board when the page has been narrowed
         to it. The icon is the same drawing either way, so the name is what says which — and
         it is worth the room, because the two destinations are not interchangeable and the
         picture alone cannot tell them apart. -->
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
            <code class={css({ fontFamily: "mono" })}>'foo</code> holds everything under
            <code class={css({ fontFamily: "mono" })}>'foo:bar</code>.
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
                <!-- Two lookups that can each miss, and the second is indexed by the result
                     of the first: a card whose partition row was not among what the loader read
                     would otherwise index `data.partitions` by `undefined`. The `{#if}` below
                     already draws nothing for a missing partition; this is what keeps the step
                     between the two records from being the thing that decides it. -->
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
            <!-- Named, because the paths below are relative to this taskspace and read as
                 nothing on their own: two taskspaces holding a `notes/todo.md` draw two
                 identical rows otherwise. -->
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

        <!-- Above the taskspace notes, because it is about the cards listed above and they
             are about the files. Same words as `kozane tag list` prints, from the same
             constant — see `CARDS_TRUNCATED_LABEL`. -->
        {#if data.cardsTruncated}
          <p class={noteClass}>
            The cards were not read in full — {CARDS_TRUNCATED_LABEL}, so a tag written on one
            may be missing here.
          </p>
        {/if}

        <!-- The name is joined from the gather's own record of what it walked, which is
             guaranteed to hold it: a truncation can only be raised about a taskspace this
             gather walked. The reasons are put into words by the same helper the terminal
             uses, and so are the paths behind them — which is the half a reader can act on. -->
        {#each data.truncated as { taskspaceId, reasons, paths } (taskspaceId)}
          <p class={noteClass}>
            {taskspaceName(taskspaceId)} was not read in full — {truncationReasons(reasons)}{truncationPaths(
              paths,
            )}, so a tag written in it may be missing here.
          </p>
        {/each}

        <!-- Last, and apart from the truncations above: those say a taskspace was read and
             not to the end of it, and this says there was nothing to read. The words are the
             terminal's, from `missingTaskspaceLabel`; the command after them is set as code
             here and quoted there, which is why only the words around it are shared.

             Read through `??`, for the reason `truncationPaths` takes an absent list: a
             static export built before this field existed carries page data without it, and
             the build serving that export is this one. -->
        {#each missing as taskspaceId (taskspaceId)}
          <p class={noteClass}>{missingTaskspaceLabel(taskspaceName(taskspaceId))}.</p>
        {/each}
        {#if missing.length > 0}
          <!-- Once, under all of them: one run of it settles every record named above. -->
          <p class={noteClass}>
            Run <code class={css({ fontFamily: "mono" })}>{TASKSPACE_CLEANUP_COMMAND}</code>
            {cleanupCommandTail(missing.length)}
          </p>
        {/if}
      </section>
    </div>
  {/if}
</main>
