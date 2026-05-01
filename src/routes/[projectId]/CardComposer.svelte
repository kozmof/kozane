<script lang="ts">
  import { untrack } from "svelte";
  import BundleDropdown from "./BundleDropdown.svelte";

  interface CardData {
    id: string;
    content: string;
    bundleId: string;
  }

  interface Bundle {
    id: string;
    name: string;
    bg: string;
    dot: string;
  }

  interface Props {
    editingCard: CardData | null;
    bundles: Bundle[];
    defaultBundleId: string;
    onSubmit: (id: string | null, content: string, bundleId: string) => void;
    onCancel: () => void;
  }

  let { editingCard, bundles, defaultBundleId, onSubmit, onCancel }: Props = $props();

  let content = $state(untrack(() => editingCard?.content ?? ""));
  let bundleId = $state(untrack(() => editingCard?.bundleId ?? defaultBundleId));
  let textareaEl: HTMLTextAreaElement;

  $effect(() => {
    content = editingCard?.content ?? "";
    bundleId = editingCard?.bundleId ?? defaultBundleId;
    textareaEl?.focus();
    if (textareaEl) autoResize(textareaEl);
  });

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (content.trim()) handleSubmit();
    }
    if (e.key === "Escape") {
      onCancel();
      textareaEl?.blur();
    }
  }

  function handleSubmit() {
    if (!content.trim()) return;
    onSubmit(editingCard?.id ?? null, content.trim(), bundleId);
    content = "";
    if (textareaEl) {
      textareaEl.style.height = "auto";
      textareaEl.focus();
    }
  }

  let isEditing = $derived(!!editingCard);
  let activeBundleColor = $derived(bundles.find((b) => b.id === bundleId));
  let borderColor = $derived(
    isEditing ? (activeBundleColor?.dot ?? "#e6e1d8") : "#e6e1d8",
  );
</script>

<div class="composer">
  <!-- Top row: bundle selector + cancel hint -->
  <div class="top-row">
    <BundleDropdown {bundles} {bundleId} onChange={(id) => (bundleId = id)} />
    {#if isEditing}
      <button class="cancel-hint" onclick={onCancel}>Esc to cancel</button>
    {/if}
  </div>

  <!-- Input row -->
  <div class="input-row" style:border-color={borderColor}>
    <textarea
      bind:this={textareaEl}
      bind:value={content}
      oninput={(e) => autoResize(e.currentTarget)}
      onkeydown={handleKeyDown}
      placeholder={isEditing
        ? "Edit card… (Enter to save, Esc to cancel)"
        : "Write a card… (Enter to create, Shift+Enter for newline)"}
      rows={1}
    ></textarea>

    <button
      class="send-btn"
      aria-label={isEditing ? "Save" : "Create card"}
      style:background={content.trim() ? "#1c1a17" : "#e0dbd3"}
      style:cursor={content.trim() ? "pointer" : "default"}
      onclick={handleSubmit}
      disabled={!content.trim()}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d="M2 7h10M8 3l4 4-4 4"
          stroke={content.trim() ? "#ffffff" : "#b8b2a8"}
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>

  <div class="hint">Enter to {isEditing ? "save" : "create"} · Shift+Enter for newline</div>
</div>

<style>
  .composer {
    background: #f7f4ed;
    border-radius: 10px;
    padding: 10px 16px 14px;
    flex-shrink: 0;
  }

  .top-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }

  .cancel-hint {
    margin-left: auto;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 11px;
    color: #b0aaa2;
    font-family: inherit;
    padding: 0;
  }

  .input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #ffffff;
    border: 1px solid;
    border-radius: 8px;
    padding: 8px 10px;
    transition: border-color 0.15s;
  }

  textarea {
    flex: 1;
    resize: none;
    border: none;
    background: transparent;
    padding: 2px 0;
    font-size: 12.5px;
    line-height: 1.65;
    font-family: "IBM Plex Mono", monospace;
    color: #1c1a17;
    min-height: 24px;
  }

  .send-btn {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s;
  }

  .hint {
    margin-top: 5px;
    font-size: 10px;
    color: #b0aaa2;
  }
</style>
