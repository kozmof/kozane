<script lang="ts">
  import { enhance } from "$app/forms";
  import type { PageProps } from "./$types";
  import { css } from "styled-system/css";

  let { form }: PageProps = $props();
  let submitting = $state(false);
  let keyInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    keyInput?.focus();
  });
</script>

<svelte:head>
  <title>Log in — Kozane</title>
</svelte:head>

<main
  class={css({
    minHeight: "100vh",
    backgroundColor: "ink.lighter",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
  })}
>
  <form
    method="POST"
    use:enhance={() => {
      submitting = true;
      return async ({ update }) => {
        await update();
        submitting = false;
      };
    }}
    class={css({
      width: "100%",
      maxWidth: "360px",
      display: "flex",
      flexDirection: "column",
      gap: "16px",
      background: "ink.white",
      border: "1px solid token(colors.neutral.border)",
      borderRadius: "2px",
      padding: "28px",
    })}
  >
    <label
      class={css({ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", color: "ink.black" })}
    >
      API key
      <input
        bind:this={keyInput}
        name="apiKey"
        type="password"
        autocomplete="current-password"
        required
        class={css({
          fontFamily: "mono",
          fontSize: "13px",
          padding: "9px 10px",
          border: "1px solid token(colors.neutral.border)",
          borderRadius: "2px",
          background: "ink.white",
          color: "ink.black",
          _focusVisible: { outline: "2px solid token(colors.neutral.muted)", outlineOffset: "1px" },
        })}
      />
    </label>

    {#if form?.error}
      <p role="alert" class={css({ margin: "0", fontSize: "12px", color: "state.error" })}>
        {form.error}
      </p>
    {/if}

    <button
      type="submit"
      disabled={submitting}
      class={css({
        fontSize: "13px",
        fontFamily: "mono",
        padding: "9px 14px",
        borderRadius: "2px",
        border: "1px solid token(colors.neutral.border)",
        background: "ink.black",
        color: "ink.white",
        cursor: "pointer",
        transition: "opacity 0.1s",
        _hover: { opacity: "0.9" },
        _disabled: { cursor: "default", opacity: "0.6" },
      })}
    >
      {submitting ? "Logging in…" : "Log in"}
    </button>
  </form>
</main>
