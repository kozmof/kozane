<script lang="ts">
  import { css, cx } from "./styles/css.js";
  import type { BackendCapabilities } from "./backend/contract.js";
  let { capabilities, lifetimeNotice, floating = false }: { capabilities: Pick<BackendCapabilities, "writable">; lifetimeNotice?: string; floating?: boolean } = $props();
</script>

{#if !capabilities.writable || lifetimeNotice}
  <aside aria-label="Workspace mode" class={cx(css({ backgroundColor: "ink.white", color: "neutral.subtle", border: "1px solid token(colors.neutral.border)", borderRadius: "2px", padding: "8px 12px", fontSize: "12px", marginBottom: "12px" }), floating && css({ position: "fixed", bottom: "12px", left: "12px", zIndex: 50, maxWidth: "360px", pointerEvents: "none", marginBottom: "0" }))}>
    {#if !capabilities.writable}<p class={css({ margin: "0" })}>Read-only workspace.</p>{/if}
    {#if lifetimeNotice}<p class={css({ margin: "0" })}>{lifetimeNotice}</p>{/if}
  </aside>
{/if}
