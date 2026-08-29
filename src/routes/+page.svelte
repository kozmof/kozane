<script lang="ts">
  import type { PageProps } from "./$types";
  import { base } from "$app/paths";
  import { enhance } from "$app/forms";
  import { css } from "styled-system/css";

  let { data, form }: PageProps = $props();
  let submitting = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);
</script>

<main class={css({ padding: "48px", backgroundColor: "ink.lighter", minHeight: "100vh" })}>
  <!-- The way in to the tag index. A tag written on a card links to it, but that is only a
       way in once there is a tag to click and only ever to that one tag; the index reaches
       across every project, which is what makes this page — the one thing above them all —
       where it belongs. -->
  <div
    class={css({
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: "16px",
      marginBottom: "24px",
    })}
  >
    <h1 class={css({ fontSize: "14px", fontWeight: "400", fontFamily: "mono", color: "neutral.muted" })}>
      {data.workspaceRoot ?? "Kozane"}
    </h1>
    <a
      href="{base}/tags"
      class={css({
        fontSize: "12px",
        fontFamily: "mono",
        color: "neutral.muted",
        textDecoration: "none",
        _hover: { color: "ink.black" },
      })}
    >
      Tags →
    </a>
  </div>

  {#if data.projects.length === 0}
    {#if data.readonly}
      <p class={css({ color: "neutral.subtle", fontSize: "13px" })}>
        No projects yet. Run
        <code class={css({ fontFamily: "mono", fontSize: "12px", backgroundColor: "neutral.bg", padding: "2px 6px", borderRadius: "2px" })}>
          kozane project create &lt;name&gt;
        </code>
        to create one.
      </p>
    {:else}
      <p class={css({ color: "neutral.subtle", fontSize: "13px" })}>No projects yet.</p>
    {/if}
  {:else}
    <ul class={css({ listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" })}>
      {#each data.projects as project (project.id)}
        <li>
          <a
            href="{base}/{project.id}"
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
            <span>{project.name}</span>
            {#if project.isDefault}
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

  {#if !data.readonly}
    <form
      method="POST"
      use:enhance={() => {
        submitting = true;
        return async ({ update }) => {
          await update();
          submitting = false;
          // Refocus so several projects can be created without reaching for the mouse.
          nameInput?.focus();
        };
      }}
      class={css({ display: "flex", flexDirection: "column", gap: "8px", marginTop: "9px" })}
    >
      <div class={css({ display: "flex", alignItems: "center", gap: "8px" })}>
        <input
          bind:this={nameInput}
          name="name"
          type="text"
          aria-label="New project name"
          class={css({
            // Matches a project row's metrics, so the create line is the same height as
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
          disabled={submitting}
          title="Create project"
          aria-label="Create project"
          class={css({
            // Square, and centred against the taller input by the row's `align-items`.
            // Nudged a pixel up from there: geometric centre reads low next to the input's
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

      {#if form?.error}
        <p role="alert" class={css({ margin: "0", fontSize: "12px", color: "state.error" })}>
          {form.error}
        </p>
      {/if}
    </form>
  {/if}
</main>
