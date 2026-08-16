<script lang="ts">
  import { css } from "styled-system/css";
  import CardComposer from "./CardComposer.svelte";
  import type { CardWithGlue, BundleWithColor, GlueRel, Layer } from "$lib/types";
  import type { UiConfig } from "$lib/ui-config";

  interface Props {
    editingCard: CardWithGlue | null;
    selectedCards: CardWithGlue[];
    selectionGlueRels: GlueRel[];
    primaryCard: CardWithGlue | null;
    bundles: BundleWithColor[];
    defaultBundleId: string;
    layers: Layer[];
    otherProjects: { id: string; name: string }[];
    onSubmit: (id: string | null, content: string, bundleId: string) => void;
    onCancel: () => void;
    onBundleChange?: (bundleId: string) => void;
    onSelectionBundleChange?: (cardIds: string[], bundleId: string) => void;
    onGlueSelected?: (cardIds: string[]) => void;
    onUnglueSelected?: (cardIds: string[]) => void;
    onUnglueOne?: (cardId: string) => void;
    onDeleteSelected?: (cardIds: string[]) => void;
    onMoveToProject?: (cardIds: string[], targetProjectId: string) => void;
    onSelectionLayerChange?: (cardIds: string[], layerId: string) => void;
    onStackOrderChange?: (cardId: string, direction: "front" | "back") => void;
    onResizeToggle?: (cardId: string) => void;
    resizingCardId?: string | null;
    shortcuts: UiConfig;
  }

  let {
    editingCard,
    selectedCards,
    selectionGlueRels,
    primaryCard,
    bundles,
    defaultBundleId,
    layers,
    otherProjects,
    onSubmit,
    onCancel,
    onBundleChange,
    onSelectionBundleChange,
    onGlueSelected,
    onUnglueSelected,
    onUnglueOne,
    onDeleteSelected,
    onMoveToProject,
    onSelectionLayerChange,
    onStackOrderChange,
    onResizeToggle,
    resizingCardId = null,
    shortcuts,
  }: Props = $props();

  let composerComponent: { focusInput: () => void } = $state()!;

  export function focusInput() {
    composerComponent?.focusInput();
  }
</script>

<div
  class={css({
    position: "absolute",
    bottom: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    width: "540px",
    maxWidth: "calc(100% - 40px)",
    boxShadow: "0 1px 10px rgba(0,0,0,0.018)",
    zIndex: "50",
  })}
>
  <CardComposer
    bind:this={composerComponent}
    {editingCard}
    {selectedCards}
    {selectionGlueRels}
    {primaryCard}
    {bundles}
    {defaultBundleId}
    {layers}
    {otherProjects}
    {onSubmit}
    {onCancel}
    {onBundleChange}
    {onSelectionBundleChange}
    {onGlueSelected}
    {onUnglueSelected}
    {onUnglueOne}
    {onDeleteSelected}
    {onMoveToProject}
    {onSelectionLayerChange}
    {onStackOrderChange}
    {onResizeToggle}
    {resizingCardId}
    {shortcuts}
  />
</div>
