<script lang="ts">
  import type { PageProps } from "./$types";
  import type { Snippet } from "svelte";
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
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
    CARDS_TRUNCATED_LABEL,
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

  /** Null gathers the whole workspace, which is what this page does with no `?projectId=`. */
  const selectedProjectId = $derived(
    data.projectId ?? (browser ? page.url.searchParams.get("projectId") : null),
  );

  /**
   * Whether taskspace files are part of the answer. `?files=0` says they are not.
   *
   * Read the same way `selectedTag` is, and filtered below for the same reason: on the live
   * page the server already skipped the walk, so there is nothing to filter out and this is a
   * no-op; in a static export the hits were baked before anyone could ask, so this is the
   * real cut. One path rather than a branch only one of the two ever takes.
   */
  const showFiles = $derived(
    data.files && (!browser || page.url.searchParams.get("files") !== "0"),
  );

  const selectedProject = $derived(
    data.projects.find(({ id }) => id === selectedProjectId) ?? null,
  );

  /**
   * Whether a hit belongs to the selected project. The same rule the board draws by: a card
   * belongs to the project its bundle does, and a taskspace to its own project *or* to none
   * at all — an unplaced taskspace appears on every board, so it belongs to every project's
   * index too.
   */
  function inSelectedProject(hit: TagHit): boolean {
    if (!selectedProjectId) return true;
    if (hit.source.kind === "card") return data.cardProjects[hit.source.cardId] === selectedProjectId;
    const owner = data.taskspaces[hit.source.taskspaceId]?.projectId;
    return owner === selectedProjectId || owner === null;
  }

  /**
   * Filtered again here, which is a no-op on the live page — the server sent exactly this
   * set — and is the real selection in a static export, where every hit of every project was
   * baked in. One path rather than a branch that only one of the two ever takes.
   */
  const matchingHits = $derived.by(() => {
    if (!selectedTag) return [];
    const matches = tagMatcher(selectedTag);
    return data.hits.filter(
      (hit) =>
        matches(hit.tag) &&
        inSelectedProject(hit) &&
        (showFiles || hit.source.kind === "card"),
    );
  });

  /**
   * Capped by the same function and to the same number the server caps by, so an export and
   * the live page list alike. Already short of it on the live page, which capped before
   * sending — this is the real cut only in an export, where every hit was baked in.
   *
   * Per kind, which matters here for the same reason it matters there: the hits arrive cards
   * first, so one ceiling across both would let a much-used tag's cards push its files off
   * the page entirely. See `capHitsByKind`.
   */
  const shown = $derived(capHitsByKind(matchingHits, TAG_HITS_SHOWN_MAX));
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
   * Only a static export ever has anything to narrow, and each half says why: the live server
   * built the tree from the project it was asked about, and skipped the taskspace walk
   * outright when asked for cards alone — so on that path both of these are false and the
   * tree it sent is already the right one.
   */
  const narrowsProject = $derived(selectedProjectId !== null && data.projectId === null);
  const narrowsFiles = $derived(!showFiles && data.files);
  const tree = $derived(
    narrowsProject || narrowsFiles
      ? buildTagTree(
          data.hits.filter(
            (hit) => inSelectedProject(hit) && (showFiles || hit.source.kind === "card"),
          ),
        )
      : data.tree,
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
   * Project names by id, built once rather than searched per row. It was a linear `find`
   * called from inside an `{#each}`, so drawing a tag with two hundred cards on it walked the
   * project list two hundred times. Nothing anyone would have measured at this size; it is a
   * shape worth not having on the page that exists to draw a lot of rows at once.
   *
   * Taskspaces need no map of their own: the loader sends them as a record already keyed by
   * id, which is what `TagIndex.taskspaces` is.
   */
  const projectNames = $derived(new Map(data.projects.map(({ id, name }) => [id, name])));

  const taskspaceName = (id: string) => data.taskspaces[id]?.name || "taskspace";
  const projectName = (id: string | null | undefined) =>
    (id !== null && id !== undefined ? projectNames.get(id) : undefined) ?? "";

  /** The workspace default, which is where an unplaced taskspace's file is opened: it is on
   *  every board, so no one of them is more its own than another. */
  const defaultProjectId = $derived(
    data.projects.find(({ isDefault }) => isDefault)?.id ?? data.projects[0]?.id ?? null,
  );

  /** `?projectId=` is kept across tag links, so narrowing to a project survives browsing the
   *  tree. Both parameters are optional and independent: either, both, or neither. */
  const tagHref = (tag: string) => {
    const params = new URLSearchParams();
    if (selectedProjectId) params.set("projectId", selectedProjectId);
    params.set("tag", tag);
    return `${base}/tags?${params}`;
  };
  const projectHref = (projectId: string | null) => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (selectedTag) params.set("tag", selectedTag);
    const query = params.toString();
    return query ? `${base}/tags?${query}` : `${base}/tags`;
  };

  /**
   * A board link needs a board. A card names its own project; a file names its taskspace's,
   * falling back to the selected one and then to the default for an unplaced taskspace.
   *
   * Null where there is no board to name, and the card case can reach that too — the loader
   * takes the same care over this lookup, because `Record<string, string>` says it cannot
   * miss when it can. A card whose project is not among the data drew `/undefined?card=…`,
   * which is a row that looks right and goes nowhere.
   */
  const cardHref = (cardId: string) => {
    const projectId = data.cardProjects[cardId];
    return projectId ? `${base}/${projectId}?card=${cardId}` : null;
  };
  const fileHref = (taskspaceId: string, path: string) => {
    const projectId =
      data.taskspaces[taskspaceId]?.projectId ?? selectedProjectId ?? defaultProjectId;
    return projectId
      ? `${base}/${projectId}?taskspace=${taskspaceId}&path=${encodeURIComponent(path)}`
      : null;
  };

  /**
   * The way to ask for cards alone, and back again. `?files=0`, which the server reads as a
   * gate on the gather itself — see `+page.server.ts`.
   *
   * Offered only where there is something to turn off. A workspace with no taskspace, and a
   * plain static export, both answer about cards whatever this said, so a control that
   * changed nothing would be a control that looks broken.
   */
  const filesToggleHref = $derived.by(() => {
    const params = new URLSearchParams();
    if (selectedProjectId) params.set("projectId", selectedProjectId);
    if (selectedTag) params.set("tag", selectedTag);
    if (showFiles) params.set("files", "0");
    const query = params.toString();
    return query ? `${base}/tags?${query}` : `${base}/tags`;
  });

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
  <title>{selectedProject ? `Tags · ${selectedProject.name}` : "Tags"}</title>
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
             rows, and the project nav in the header above marks its selection this way
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
      alignItems: "baseline",
      flexWrap: "wrap",
      gap: "6px 14px",
      fontSize: "12px",
      fontFamily: "mono",
    })}
  >
    <a
      href="{base}/{selectedProjectId ?? ''}"
      class={css({
        color: "neutral.muted",
        textDecoration: "none",
        _hover: { color: "ink.black" },
      })}
    >
      ← {selectedProject ? selectedProject.name : "Projects"}
    </a>

    <!-- Which project the index is narrowed to, and the way to change it. Picking the
         project already selected clears the narrowing, which is the way back to the whole
         workspace now that it has no row of its own. -->
    <nav
      aria-label="Scope"
      class={css({ display: "flex", flexWrap: "wrap", gap: "10px", marginLeft: "auto" })}
    >
      <!-- Cards alone, or cards and taskspace files. A taskspace of source code tags every
           quoted string literal in it, so the index over one is mostly noise; this is the
           way to put it down without giving up the tags written on cards. -->
      {#if data.filesAvailable}
        <a
          href={filesToggleHref}
          class={css({
            textDecoration: "none",
            color: "neutral.subtle",
            _hover: { color: "ink.black" },
          })}
        >
          {showFiles ? "Cards only" : "Include files"}
        </a>
      {/if}
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

  {#if tree.length === 0}
    <p class={css({ color: "neutral.subtle", fontSize: "13px", maxWidth: "52ch" })}>
      No tags yet. Write <code class={css({ fontFamily: "mono" })}>'like:this</code> in a card
      or in a taskspace file, and it will be gathered here.
    </p>
  {:else}
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
                {@const bundle = data.bundles[data.cardBundleIds[cardId]]}
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
                      {#if bundle}
                        <span
                          style="background: {bundle.dot}"
                          class={css({ width: "8px", height: "8px", borderRadius: "999px" })}
                        ></span>
                        {bundle.name}
                      {/if}
                      <!-- Only when gathering across the workspace, where which board a card
                           is on is the thing a row cannot otherwise say. -->
                      {#if !selectedProjectId}
                        <span>{projectName(data.cardProjects[cardId])}</span>
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
          <p class={css({ fontSize: "12px", color: "neutral.subtle", marginTop: "8px" })}>
            The cards were not read in full — {CARDS_TRUNCATED_LABEL}, so a tag written on one
            may be missing here.
          </p>
        {/if}

        <!-- The name is joined from the gather's own record of what it walked, which is
             guaranteed to hold it: a truncation can only be raised about a taskspace this
             gather walked. The reasons are put into words by the same helper the terminal
             uses, and so are the paths behind them — which is the half a reader can act on. -->
        {#each data.truncated as { taskspaceId, reasons, paths } (taskspaceId)}
          <p class={css({ fontSize: "12px", color: "neutral.subtle", marginTop: "8px" })}>
            {taskspaceName(taskspaceId)} was not read in full — {truncationReasons(reasons)}{truncationPaths(
              paths,
            )}, so a tag written in it may be missing here.
          </p>
        {/each}
      </section>
    </div>
  {/if}
</main>
