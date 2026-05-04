<script lang="ts">
  import { css } from "styled-system/css";
  import CardComposer from "./CardComposer.svelte";
  import type { CardData, BundleWithColor, GlueRel } from "$lib/types";

  interface Props {
    editingCard: CardData | null;
    selectedCards: CardData[];
    selectionGlueRels: GlueRel[];
    primaryCard: CardData | null;
    bundles: BundleWithColor[];
    defaultBundleId: string;
    onSubmit: (id: string | null, content: string, bundleId: string) => void;
    onCancel: () => void;
    onBundleChange?: (bundleId: string) => void;
    onSelectionBundleChange?: (cardIds: string[], bundleId: string) => void;
    onGlueSelected?: (cardIds: string[]) => void;
    onUnglueSelected?: (cardIds: string[]) => void;
    onUnglueOne?: (cardId: string) => void;
    onDeleteSelected?: (cardIds: string[]) => void;
  }

  let {
    editingCard,
    selectedCards,
    selectionGlueRels,
    primaryCard,
    bundles,
    defaultBundleId,
    onSubmit,
    onCancel,
    onBundleChange,
    onSelectionBundleChange,
    onGlueSelected,
    onUnglueSelected,
    onUnglueOne,
    onDeleteSelected,
  }: Props = $props();
</script>

<div
  class={css({
    position: "absolute",
    bottom: "20px",
    left: "50%",
    transform: "translateX(-50%)",
    width: "540px",
    maxWidth: "calc(100% - 40px)",
    borderRadius: "10px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.13), 0 1px 4px rgba(0,0,0,0.08)",
    zIndex: "50",
  })}
>
  <CardComposer
    {editingCard}
    {selectedCards}
    {selectionGlueRels}
    {primaryCard}
    {bundles}
    {defaultBundleId}
    {onSubmit}
    {onCancel}
    {onBundleChange}
    {onSelectionBundleChange}
    {onGlueSelected}
    {onUnglueSelected}
    {onUnglueOne}
    {onDeleteSelected}
  />
</div>
