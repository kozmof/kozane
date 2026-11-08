<script lang="ts">
  import RefreshNotice from "../RefreshNotice.svelte";
  import ClientNotice from "../ClientNotice.svelte";
  import type { NavigationAdapter } from "../navigation.js";
  import type { NamespaceGetResult } from "../backend/contract.js";
  import type { NamespacesViewClient } from "../backend/view-clients.js";
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import { NamespaceIndex } from "../backend/namespace-index.svelte.js";
  import { css } from "../styles/css.js";
  import NavIcon from "../components/NavIcon.svelte";

  let { backend, initialNamespaces, navigation, workspaceName = null, workspaceLabel = "Kozane", formError = null, lifetimeNotice, createAction, emptyState, retryIntervalMs = 1000 }: {
    backend: NamespacesViewClient;
    initialNamespaces: NamespaceGetResult[];
    navigation: NavigationAdapter;
    workspaceName?: string | null;
    lifetimeNotice?: string;
    workspaceLabel?: string;
    formError?: string | null;
    /** Optional app-owned endpoint for progressive form submission. */
    createAction?: string;
    /** Optional app-specific guidance for an empty read-only workspace. */
    emptyState?: Snippet;
    /** Disable scheduled read retries when the host provides immutable data. */
    retryIntervalMs?: number | false;
  } = $props();
  let refreshAttempt = $state(0);
  const index = $derived(new NamespaceIndex(backend, initialNamespaces));
  $effect(() => {
    const current = index;
    // oxlint-disable-next-line no-unused-expressions
    refreshAttempt;
    const interval = retryIntervalMs;
    return untrack(() => current.start({ retryIntervalMs: interval }));
  });
  async function createNamespace(event: SubmitEvent) {
    event.preventDefault();
    const current = index;
    const generation = backend.version.generation;
    const created = await current.create(nameInput?.value ?? "");
    if (current !== index || generation !== backend.version.generation || backend.state.status !== "ready") return;
    if (created) {
      if (nameInput) nameInput.value = "";
    }
    nameInput?.focus();
  }
  let nameInput = $state<HTMLInputElement | null>(null);

  /**
   * Use a dim resting color and dark hover color for header navigation icons. Add padding
   * around the drawing to enlarge the click target.
   */
  const navLinkClass = css({
    display: "flex",
    alignItems: "center",
    padding: "6px",
    borderRadius: "2px",
    color: "neutral.iconDim",
    textDecoration: "none",
    _hover: { color: "ink.black", backgroundColor: "neutral.border" },
  });
</script>

<svelte:head>
  <title>{workspaceName ?? "Kozane"}</title>
</svelte:head>

<main class={css({ padding: "48px", backgroundColor: "ink.lighter", minHeight: "100vh" })}>
  <!-- Link to workspace-wide map and tag views from the namespace index. These links also let the prerender crawler discover the routes. -->
  <div
    class={css({
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "16px",
      marginBottom: "24px",
    })}
  >
    <h1 class={css({ fontSize: "14px", fontWeight: "400", fontFamily: "mono", color: "neutral.muted" })}>
      {workspaceLabel}
    </h1>
    <nav aria-label="Across the workspace" class={css({ display: "flex", gap: "4px" })}>
      <a href={navigation.map()} title="Map" aria-label="Map" class={navLinkClass}>
        <NavIcon kind="map" />
      </a>
      <a href={navigation.tags()} title="Tags" aria-label="Tags" class={navLinkClass}>
        <NavIcon kind="tags" />
      </a>
    </nav>
  </div>

  <ClientNotice capabilities={backend.capabilities} {lifetimeNotice} />
  <RefreshNotice {backend} failed={index.refreshError !== null} message="Could not refresh namespaces. Showing the last results." retry={() => refreshAttempt++} />

  {#if index.namespaces.length === 0}
    {#if !backend.capabilities.writable && emptyState}
      <p class={css({ color: "neutral.subtle", fontSize: "13px" })}>{@render emptyState()}</p>
    {:else}
      <p class={css({ color: "neutral.subtle", fontSize: "13px" })}>No namespaces yet.</p>
    {/if}
  {:else}
    <ul class={css({ listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" })}>
      {#each index.namespaces as namespace (namespace.id)}
        <li>
          <a
            href={navigation.board(namespace.id)}
            class={css({
              color: "ink.black",
              textDecoration: "none",
              fontSize: "14px",
              padding: "10px 14px",
              // Pinned so a row with the "Default" pill and a row without it are the same
              // height, and so the create row below the list can match them.
              minHeight: "42px",
              background: "ink.white",
              border: "1px solid token(colors.neutral.border)",
              borderRadius: "2px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              transition: "border-color 0.1s",
              _hover: { borderColor: "neutral.muted" },
            })}
          >
            <span>{namespace.name}</span>
            {#if namespace.isDefault}
              <span
                class={css({
                  color: "neutral.muted",
                  backgroundColor: "neutral.bg",
                  display: "inline-flex",
                  alignItems: "center",
                  minHeight: "20px",
                  borderRadius: "999px",
                  padding: "2px 8px",
                  fontFamily: "mono",
                  fontSize: "11px",
                  lineHeight: "1",
                })}
              >
                Default
              </span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  {#if backend.capabilities.writable}
    <form
      method="POST"
      action={createAction}
      onsubmit={createNamespace}
      class={css({ display: "flex", flexDirection: "column", gap: "8px", marginTop: "9px" })}
    >
      <div class={css({ display: "flex", alignItems: "center", gap: "8px" })}>
        <input
          bind:this={nameInput}
          name="name"
          type="text"
          aria-label="New namespace name"
          class={css({
            // Matches a namespace row's metrics, so the create line is the same height as
            // the entries above it.
            fontSize: "14px",
            fontFamily: "inherit",
            padding: "10px 14px",
            minHeight: "38px",
            width: "100%",
            maxWidth: "320px",
            border: "1px solid token(colors.neutral.border)",
            borderRadius: "2px",
            background: "ink.white",
            color: "ink.black",
            _focusVisible: { outline: "2px solid token(colors.neutral.muted)", outlineOffset: "1px" },
          })}
        />
        <button
          type="submit"
          disabled={index.submitting || !backend.capabilities.writable || !index.current}
          title="Create namespace"
          aria-label="Create namespace"
          class={css({
            // Square, and centred against the taller input by the row's `align-items`.
            // Nudged a pixel up from there, because geometric centre reads low next to the input's
            // text, which sits above the input's own centre line.
            position: "relative",
            top: "-1px",
            width: "32px",
            height: "32px",
            flexShrink: "0",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "16px",
            fontFamily: "mono",
            lineHeight: "1",
            borderRadius: "2px",
            border: "1px solid token(colors.neutral.border)",
            background: "ink.black",
            color: "ink.white",
            cursor: "pointer",
            transition: "opacity 0.1s",
            _hover: { opacity: "0.9" },
            _disabled: { cursor: "default", opacity: "0.6" },
          })}
        >+</button>
      </div>

      {#if !index.current}
        <p role="status" class={css({ margin: "0", fontSize: "12px", color: "neutral.subtle" })}>Namespace creation is paused while current data loads.</p>
      {/if}
      {#if index.error || formError}
        <p role="alert" class={css({ margin: "0", fontSize: "12px", color: "state.error" })}>
          {index.error ?? formError}
        </p>
      {/if}
    </form>
  {/if}
</main>
