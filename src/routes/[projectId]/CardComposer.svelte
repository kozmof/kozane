<script lang="ts">
  import { untrack } from "svelte";
  import BundleDropdown from "./BundleDropdown.svelte";
  import { css } from "styled-system/css";

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
  let borderColor = $derived(isEditing ? (activeBundleColor?.dot ?? "#e6e1d8") : "#e6e1d8");
</script>

<div class={css({ backgroundColor: "ink.light", borderRadius: "10px", padding: "10px 16px 14px", flexShrink: "0" })}>
  <!-- Top row: bundle selector + cancel hint -->
  <div class={css({ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" })}>
    <BundleDropdown {bundles} {bundleId} onChange={(id) => (bundleId = id)} />
    {#if isEditing}
      <button
        class={css({ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: "warm.muted", fontFamily: "inherit", padding: "0" })}
        onclick={onCancel}
      >Esc to cancel</button>
    {/if}
  </div>

  <!-- Input row -->
  <div
    class={css({ display: "flex", alignItems: "center", gap: "8px", background: "#ffffff", border: "1px solid", borderRadius: "8px", padding: "8px 10px", transition: "border-color 0.15s" })}
    style:border-color={borderColor}
  >
    <textarea
      class={css({ flex: "1", resize: "none", border: "none", background: "transparent", padding: "2px 0", fontSize: "12.5px", lineHeight: "1.65", fontFamily: "mono", color: "ink.black", minHeight: "24px" })}
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
      class={css({ flexShrink: "0", width: "32px", height: "32px", borderRadius: "6px", border: "none", display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s" })}
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

  <div class={css({ marginTop: "5px", fontSize: "10px", color: "warm.muted" })}>
    Enter to {isEditing ? "save" : "create"} · Shift+Enter for newline
  </div>
</div>
