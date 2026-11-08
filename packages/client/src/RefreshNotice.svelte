<script lang="ts">
  import { untrack } from "svelte";
  import { css } from "./styles/css.js";
  import type { ClientState } from "./backend/contract.js";
  import type { ClientStatus } from "./backend/view-clients.js";
  let { backend, failed = false, message, retry, floating = false }: {
    backend?: ClientStatus;
    failed?: boolean;
    message: string;
    retry: () => void;
    floating?: boolean;
  } = $props();
  let currentState = $state.raw<ClientState | undefined>(untrack(() => backend?.state));
  $effect(() => {
    const current = backend;
    return untrack(() => {
      currentState = current?.state;
      return current?.subscribeState((value) => { currentState = value; });
    });
  });
  const pollingFailed = $derived(currentState?.status === "ready" && currentState.refreshError !== undefined);
</script>

{#if failed || pollingFailed}
  <p role="status" class={css({ fontSize: "12px", color: "state.error", backgroundColor: "ink.white", padding: "8px 12px", marginBottom: "16px", position: floating ? "fixed" : "relative", top: floating ? "12px" : undefined, left: floating ? "12px" : undefined, zIndex: floating ? 100 : undefined })}>
    {pollingFailed ? "Could not check workspace changes. Showing the last results." : message}
    <button type="button" onclick={retry} class={css({ marginLeft: "8px", fontSize: "12px", cursor: "pointer" })}>Retry</button>
  </p>
{/if}
