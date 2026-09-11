<script lang="ts">
  import { css } from "styled-system/css";
  import CardComposer from "./CardComposer.svelte";
  import type { CardWithGlue, PartitionWithColor, GlueRel, Layer } from "$lib/types";
  import type { UiConfig } from "$lib/ui-config";

  interface Props {
    editingCard: CardWithGlue | null;
    selectedCards: CardWithGlue[];
    selectionGlueRels: GlueRel[];
    primaryCard: CardWithGlue | null;
    partitions: PartitionWithColor[];
    defaultPartitionId: string;
    layers: Layer[];
    otherNamespaces: { id: string; name: string }[];
    onSubmit: (id: string | null, content: string, partitionId: string) => void;
    onCancel: () => void;
    onPartitionChange?: (partitionId: string) => void;
    onSelectionPartitionChange?: (cardIds: string[], partitionId: string) => void;
    onGlueSelected?: (cardIds: string[]) => void;
    onUnglueSelected?: (cardIds: string[]) => void;
    onUnglueOne?: (cardId: string) => void;
    onDeleteSelected?: (cardIds: string[]) => void;
    onMoveToNamespace?: (cardIds: string[], targetNamespaceId: string) => void;
    onSelectionLayerChange?: (cardIds: string[], layerId: string) => void;
    onStackOrderChange?: (cardIds: string[], direction: "front" | "back") => void;
    onResizeToggle?: (cardId: string) => void;
    onSquashCard?: (cardId: string) => void;
    resizingCardId?: string | null;
    shortcuts: UiConfig;
  }

  let {
    editingCard,
    selectedCards,
    selectionGlueRels,
    primaryCard,
    partitions,
    defaultPartitionId,
    layers,
    otherNamespaces,
    onSubmit,
    onCancel,
    onPartitionChange,
    onSelectionPartitionChange,
    onGlueSelected,
    onUnglueSelected,
    onUnglueOne,
    onDeleteSelected,
    onMoveToNamespace,
    onSelectionLayerChange,
    onStackOrderChange,
    onResizeToggle,
    onSquashCard,
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
    {partitions}
    {defaultPartitionId}
    {layers}
    {otherNamespaces}
    {onSubmit}
    {onCancel}
    {onPartitionChange}
    {onSelectionPartitionChange}
    {onGlueSelected}
    {onUnglueSelected}
    {onUnglueOne}
    {onDeleteSelected}
    {onMoveToNamespace}
    {onSelectionLayerChange}
    {onStackOrderChange}
    {onResizeToggle}
    {onSquashCard}
    {resizingCardId}
    {shortcuts}
  />
</div>
