<script lang="ts">
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";
  import { base } from "$app/paths";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import {
    buildTagTree,
    groupHitRows,
    isCardHit,
    isFileHit,
    normalizeTag,
    taggedWith,
    tagMatcher,
    tagMatches,
    type TagCounts,
    type TagHitOf,
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
    const owner = data.taskspaceProjects[hit.source.taskspaceId];
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
    return data.hits.filter((hit) => matches(hit.tag) && inSelectedProject(hit));
  });

  /**
   * Capped the same way and to the same number the server caps by, so an export and the live
   * page list alike. Already short of it on the live page, which capped before sending.
   */
  const shownHits = $derived(matchingHits.slice(0, TAG_HITS_SHOWN_MAX));

  /** What the list above is a part of. The server counted it before capping; in an export
   *  nothing was capped before the filter just above, so the count is taken from that. */
  const hitTotal = $derived(data.hitTotal ?? matchingHits.length);

  /**
   * The tree, narrowed the same way. Only a static export ever has anything to narrow: the
   * live server built the tree from the project it was asked about.
   */
  const tree = $derived(
    selectedProjectId && data.projectId === null
      ? buildTagTree(data.hits.filter(inSelectedProject))
      : data.tree,
  );

  /**
   * One row per card, not per hit. A card written `'perf:cache and 'perf` matches a search
   * for `'perf` twice, and two rows would read as two cards. What counts as a row is
   * `groupHitRows` in `$lib/tag`, which the terminal groups by too.
   */
  const cardRows = $derived(groupHitRows(shownHits.filter(isCardHit)));

  /** File hits gathered under the taskspace they were found in, so a path is read against
   *  the directory it is relative to rather than on its own — and within that, one row per
   *  line, since each is somewhere to go and look. */
  const fileRowsByTaskspace = $derived.by(() => {
    const byTaskspace = new Map<string, TagHitOf<TagHit, "file">[]>();
    for (const hit of shownHits) {
      if (!isFileHit(hit)) continue;
      const existing = byTaskspace.get(hit.source.taskspaceId);
      if (existing) existing.push(hit);
      else byTaskspace.set(hit.source.taskspaceId, [hit]);
    }
    return [...byTaskspace].map(([taskspaceId, hits]) => ({
      taskspaceId,
      rows: groupHitRows(hits),
    }));
  });

  const taskspaceName = (id: string) =>
    data.taskspaces.find((taskspace) => taskspace.id === id)?.name || "taskspace";
  const projectName = (id: string | null | undefined) =>
    data.projects.find((project) => project.id === id)?.name ?? "";

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

  /** A board link needs a board. A card names its own project; a file names its taskspace's,
   *  falling back to the selected one and then to the default for an unplaced taskspace. */
  const cardHref = (cardId: string) => `${base}/${data.cardProjects[cardId]}?card=${cardId}`;
  const fileHref = (taskspaceId: string, path: string) => {
    const projectId =
      data.taskspaceProjects[taskspaceId] ?? selectedProjectId ?? defaultProjectId;
    return projectId
      ? `${base}/${projectId}?taskspace=${taskspaceId}&path=${encodeURIComponent(path)}`
      : null;
  };

  /** A node is open while the selected tag is inside it, so arriving on `'foo:bar:baz` by
   *  link opens the tree down to it rather than showing a collapsed root. */
  const isOpen = (node: TagNode) => !!selectedTag && tagMatches(node.tag, selectedTag);

  /** One number: what selecting this tag would put in the panel. Cards and files were drawn
   *  apart, which left the question the tree is actually read for — how much is under this
   *  tag — as a sum for the reader to do. Which kind each hit is, the panel says row by row. */
  const countLabel = ({ cards, files }: TagCounts) => `${cards + files}`;

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
</script>

<svelte:head>
  <title>{selectedProject ? `Tags · ${selectedProject.name}` : "Tags"}</title>
</svelte:head>

{#snippet branch(nodes: TagNode[], depth: number)}
  <ul class={css({ listStyle: "none", margin: "0", padding: "0" })}>
    {#each nodes as node (node.tag)}
      <li>
        <a
          href={tagHref(node.tag)}
          style="padding-left: {8 + depth * 14}px"
          class="{rowClass} {selectedTag === node.tag ? activeRowClass : ''}"
        >
          <span class={css({ fontFamily: "mono" })}>{node.name}</span>
          <span class={countClass}>{countLabel(node.total)}</span>
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

          {#if shownHits.length === 0}
            <p class={css({ color: "neutral.subtle", fontSize: "13px" })}>Nothing under this tag.</p>
          {:else if hitTotal > shownHits.length}
            <!-- The tree's count is of the whole thing, so a capped list has to say it is
                 one, or the two numbers read as a disagreement. -->
            <p
              class={css({ color: "neutral.subtle", fontSize: "12px", marginBottom: "12px" })}
            >
              Showing the first {shownHits.length} of {hitTotal}. Narrow with a subcategory to
              see the rest.
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
                  <a
                    href={cardHref(cardId)}
                    class={css({
                      display: "block",
                      padding: "10px 14px",
                      background: "ink.white",
                      border: "1px solid token(colors.neutral.border)",
                      borderRadius: "2px",
                      textDecoration: "none",
                      transition: "border-color 0.1s",
                      _hover: { borderColor: "neutral.muted" },
                    })}
                  >
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
                  </a>
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
                  <a
                    href={fileHref(taskspaceId, source.path)}
                    class={css({
                      display: "flex",
                      gap: "12px",
                      alignItems: "baseline",
                      padding: "6px 14px",
                      background: "ink.white",
                      border: "1px solid token(colors.neutral.border)",
                      borderRadius: "2px",
                      textDecoration: "none",
                      transition: "border-color 0.1s",
                      _hover: { borderColor: "neutral.muted" },
                    })}
                  >
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
                  </a>
                </li>
              {/each}
            </ul>
          {/each}
        {/if}

        {#each data.truncated as { taskspaceId, reasons } (taskspaceId)}
          <p class={css({ fontSize: "12px", color: "neutral.subtle", marginTop: "8px" })}>
            {taskspaceName(taskspaceId)} was not read in full ({reasons.join(", ")}), so a tag
            written in it may be missing here.
          </p>
        {/each}
      </section>
    </div>
  {/if}
</main>
