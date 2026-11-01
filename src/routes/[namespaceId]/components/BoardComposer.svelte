<script lang="ts">
  import type { ComponentProps } from "svelte";
  import type { NamespaceState } from "../namespace-state.svelte.js";
  import type { createNamespaceActions } from "../namespace-actions.svelte.js";
  import FloatingComposer from "./FloatingComposer.svelte";
  import ScopeAreaPrompt from "./ScopeAreaPrompt.svelte";

  type ComposerProps = ComponentProps<typeof FloatingComposer>;

  /**
   * The bottom bar of a writable board: the card composer, or the scope prompt in its place
   * while an Alt-drawn rectangle awaits a scope.
   */
  type Props = {
    s: NamespaceState;
    actions: ReturnType<typeof createNamespaceActions>;
    /** Whether a drawn rectangle is waiting for the prompt's answer. */
    hasPendingFrame: boolean;
    /** Cards the pending rectangle covers, shown in the prompt. */
    pendingFrameCardCount: number;
    onChooseScope: (scopeId: string) => void;
    onCreateScope: (name: string) => void;
    onCancelFrame: () => void;
    partitions: ComposerProps["partitions"];
    defaultPartitionId: string;
    otherNamespaces: ComposerProps["otherNamespaces"];
    onSubmit: ComposerProps["onSubmit"];
    onResizeToggle: ComposerProps["onResizeToggle"];
    onOpenFilePalette: () => void;
    filePaletteOpen: boolean;
    newCardTarget: string | null;
    shortcuts: ComposerProps["shortcuts"];
  };

  let {
    s,
    actions,
    hasPendingFrame,
    pendingFrameCardCount,
    onChooseScope,
    onCreateScope,
    onCancelFrame,
    partitions,
    defaultPartitionId,
    otherNamespaces,
    onSubmit,
    onResizeToggle,
    onOpenFilePalette,
    filePaletteOpen,
    newCardTarget,
    shortcuts,
  }: Props = $props();

  let composerComponent: { focusInput: () => void } | undefined = $state();

  /** Focus the composer's text box. A no-op while the scope prompt stands in for it. */
  export function focusInput() {
    composerComponent?.focusInput();
  }

  // One pass over the cards instead of a scan per selected id. A selection is capped at
  // BATCH_MAX, so the pair-wise form was up to two thousand scans of the whole board on
  // every keystroke that touched the selection.
  let cardById = $derived(new Map(s.cards.map((c) => [c.id, c])));
  // Drop selected IDs whose cards were deleted before the next snapshot arrived.
  let selectedCardObjects = $derived(
    [...s.selection.selectedCards].flatMap((id) => cardById.get(id) ?? []),
  );
  let selectionGlueRels = $derived(s.glueRels.filter((r) => s.selection.selectedCards.has(r.cardId)));
  let primaryCard = $derived(
    s.selection.primarySelectedId ? (cardById.get(s.selection.primarySelectedId) ?? null) : null,
  );

  function clearSelection() {
    s.selection.composerCard = null;
    s.selection.selectedCards = new Set();
    s.selection.primarySelectedId = null;
  }
</script>

{#if hasPendingFrame}
  <ScopeAreaPrompt
    scopes={s.scopes}
    cardCount={pendingFrameCardCount}
    onChoose={onChooseScope}
    onCreate={onCreateScope}
    onCancel={onCancelFrame}
  />
{:else}
  <FloatingComposer
    bind:this={composerComponent}
    editingCard={s.selection.composerCard}
    selectedCards={selectedCardObjects}
    {selectionGlueRels}
    {primaryCard}
    {partitions}
    {defaultPartitionId}
    layers={s.layers}
    {onSubmit}
    onCancel={clearSelection}
    onPartitionChange={actions.handleCardPartitionChange}
    onSelectionPartitionChange={actions.handleSelectionPartitionChange}
    onGlueSelected={actions.handleGlueSelected}
    onUnglueSelected={actions.handleUnglueSelected}
    onUnglueOne={actions.handleUnglueOne}
    onDeleteSelected={actions.handleDeleteSelected}
    {otherNamespaces}
    onMoveToNamespace={actions.handleMoveSelectionToNamespace}
    onSelectionLayerChange={actions.handleSelectionLayerChange}
    onStackOrderChange={actions.handleStackOrderChange}
    {onResizeToggle}
    onSquashCard={actions.handleSquashCard}
    {onOpenFilePalette}
    suspendShortcuts={filePaletteOpen}
    resizingCardId={s.selection.resizingCardId}
    {newCardTarget}
    {shortcuts}
  />
{/if}
