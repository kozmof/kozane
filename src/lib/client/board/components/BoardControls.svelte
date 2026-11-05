<script lang="ts">
  import { css } from "styled-system/css";
  import type { NamespaceState } from "../namespace-state.svelte.js";
  import type { createNamespaceActions } from "../namespace-actions.svelte.js";
  import LayerControl from "./LayerControl.svelte";
  import ScopeControl from "./ScopeControl.svelte";
  import SidePanelToggle from "./SidePanelToggle.svelte";

  /** The top-right icons. They share one row packed to the right, so hiding one leaves no gap. */
  type Props = {
    s: NamespaceState;
    actions: ReturnType<typeof createNamespaceActions>;
    showScopeControl: boolean;
    showLayerControl: boolean;
    showSidePanelToggle: boolean;
    sidebarsVisible: boolean;
    readonly: boolean;
  };

  let {
    s,
    actions,
    showScopeControl,
    showLayerControl,
    showSidePanelToggle,
    sidebarsVisible = $bindable(),
    readonly,
  }: Props = $props();
</script>

<div
  class={css({
    position: "absolute",
    top: "12px",
    right: "16px",
    zIndex: "51",
    display: "flex",
    gap: "8px",
  })}
  data-testid="board-controls"
>
  {#if showScopeControl}
    <ScopeControl scopes={s.scopes} bind:activeScope={s.sidebar.activeScope} />
  {/if}
  {#if showLayerControl}
    <LayerControl
      layers={s.layers}
      cards={s.cards}
      bind:activeLayerId={s.activeLayerId}
      onCreateLayer={actions.handleCreateLayer}
      onDeleteLayer={actions.handleDeleteLayer}
      onRenameLayer={actions.handleRenameLayer}
      onReorderLayers={actions.handleReorderLayers}
      {readonly}
    />
  {/if}
  {#if showSidePanelToggle}
    <SidePanelToggle
      {sidebarsVisible}
      onToggleSidebars={() => (sidebarsVisible = !sidebarsVisible)}
    />
  {/if}
</div>
