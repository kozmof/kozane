<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { Scope } from "$lib/types";

  let {
    scopes,
    activeScope = $bindable(),
  }: {
    // Already narrowed to this project by the snapshot, the same list the side panel gets.
    scopes: Scope[];
    activeScope: string | null;
  } = $props();

  let open = $state(false);
  let controlEl: HTMLDivElement = $state()!;

  const active = $derived(scopes.find((s) => s.id === activeScope) ?? null);

  // Nothing to pick from and nothing to escape: the control has no reason to exist on a
  // board that has never had a scope.
  const hasScopes = $derived(scopes.length > 0);

  $effect(() => {
    if (!open) return;
    function handleDown(e: MouseEvent) {
      if (!controlEl?.contains(e.target as Node)) open = false;
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  });

  function choose(scopeId: string | null) {
    activeScope = scopeId;
    open = false;
  }

  const triggerBase = css({
    width: "28px",
    height: "28px",
    borderRadius: "2px",
    border: "1px solid",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 1px 3px rgba(0,0,0,0.018)",
  });
  // Split rather than overridden so neither state depends on which atom Panda emits last.
  const triggerRestClass = css({
    backgroundColor: "ink.light",
    borderColor: "neutral.border",
    // A lone lid stroke carries much less weight than the filled open eye, so it is drawn
    // darker than a resting icon otherwise would be, to hold the corner at all.
    color: "neutral.iconDim",
  });
  // The same filled treatment the focused row in the side panel carries, so the two places
  // that report this one state look like the same state.
  const triggerFocusedClass = css({
    backgroundColor: "ink.charcoal",
    borderColor: "ink.charcoal",
    color: "ink.light",
  });

  const rowClass = css({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "6px 10px",
    border: "none",
    borderRadius: "2px",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "12px",
    color: "ink.black",
    textAlign: "left",
    background: "transparent",
    "&:hover": { background: "ink.lighter" },
  });
  const rowNameClass = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
</script>

{#snippet closedEyeGlyph()}
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M1 5.8C3 8.6 4.9 9.7 7 9.7S11 8.6 13 5.8"
      stroke="currentColor"
      stroke-width="1.1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
{/snippet}

{#snippet eyeGlyph()}
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M1 7C3 4.2 4.9 3.1 7 3.1S11 4.2 13 7c-2 2.8-3.9 3.9-6 3.9S3 9.8 1 7Z"
      stroke="currentColor"
      stroke-width="1.1"
      stroke-linejoin="round"
    />
    <circle cx="7" cy="7" r="1.8" fill="currentColor" />
  </svg>
{/snippet}

{#if hasScopes}
  <div
    bind:this={controlEl}
    class={css({ position: "absolute", top: "12px", right: "88px", zIndex: "51" })}
    onkeydown={(e) => {
      if (e.key !== "Escape" || !open) return;
      // Close the menu without disturbing the focus the board is already under; leaving a
      // scope is what the "No scope" row is for.
      e.stopPropagation();
      open = false;
    }}
    role="presentation"
  >
    <button
      class={cx(triggerBase, active ? triggerFocusedClass : triggerRestClass)}
      title={active ? `Focused on ${active.name}` : "Focus a scope"}
      aria-label={active ? `Focused on scope ${active.name}` : "Focus a scope"}
      aria-expanded={open}
      aria-haspopup="listbox"
      onclick={() => (open = !open)}
    >
      <!-- The eye is the state, the same as in the side panel: this is the scope the board
           is being looked at through. -->
      {#if active}{@render eyeGlyph()}{:else}{@render closedEyeGlyph()}{/if}
    </button>

    {#if open}
      <div class={css({ position: "absolute", top: "100%", right: "0", paddingTop: "6px" })}>
        <div
          role="listbox"
          aria-label="Scopes"
          class={css({
            background: "ink.white",
            border: "1px solid token(colors.neutral.border)",
            borderRadius: "2px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.03)",
            padding: "4px",
            minWidth: "160px",
            maxHeight: "260px",
            overflowY: "auto",
          })}
        >
          <!-- The way out. The board can be left under a scope indefinitely, so escaping one
               has to be reachable from the same control that entered it. -->
          <button
            class={rowClass}
            role="option"
            aria-selected={active === null}
            style:background={active === null ? "var(--colors-neutral-bg)" : "transparent"}
            onclick={() => choose(null)}
          >
            <span class={rowNameClass}>No scope</span>
            {#if active === null}
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style:margin-left="auto">
                <path d="M1 4l3 3 5-6" stroke="var(--colors-ink-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
          </button>

          {#each scopes as scope (scope.id)}
            {@const isActive = scope.id === activeScope}
            <button
              class={rowClass}
              role="option"
              aria-selected={isActive}
              style:background={isActive ? "var(--colors-neutral-bg)" : "transparent"}
              onclick={() => choose(scope.id)}
            >
              <span class={rowNameClass}>{scope.name}</span>
              {#if isActive}
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style:margin-left="auto">
                  <path d="M1 4l3 3 5-6" stroke="var(--colors-ink-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}
