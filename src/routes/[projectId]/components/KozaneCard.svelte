<script lang="ts">
  import { css } from "styled-system/css";
  import type { CardWithGlue, BundleWithColor } from "$lib/types";
  import { linkify } from "$lib/linkify";

  interface Props {
    card: CardWithGlue;
    color: BundleWithColor;
    isSelected: boolean;
    isPrimaryUnglue: boolean;
    isComposing: boolean;
    dimmed: boolean;
    isDragging: boolean;
    zIndex?: number;
    showFooters: boolean;
    cardWidth: number;
    fontSize: number;
    fontFamily: string;
    onCardMouseDown: (e: MouseEvent) => void;
    onCardClick: (e: MouseEvent) => void;
    onCardDblClick: () => void;
  }

  let {
    card,
    color,
    isSelected,
    isPrimaryUnglue,
    isComposing,
    dimmed,
    isDragging,
    zIndex = 0,
    showFooters,
    cardWidth,
    fontSize,
    fontFamily,
    onCardMouseDown,
    onCardClick,
    onCardDblClick,
  }: Props = $props();

  let background = $derived(
    isPrimaryUnglue
      ? "var(--colors-select-bg)"
      : isSelected
        ? "var(--colors-select-surface)"
        : "var(--colors-ink-white)",
  );

  let border = $derived(
    isComposing
      ? `1px solid ${color.dot}`
      : isSelected || isPrimaryUnglue
        ? "1px solid var(--colors-select-accent)"
        : "1px solid var(--colors-neutral-card)",
  );
</script>

<div
  role="button"
  aria-label={card.content ? `Card: ${card.content}` : "Empty card"}
  aria-pressed={isSelected}
  tabindex="0"
  data-card-id={card.id}
  onmousedown={onCardMouseDown}
  onclick={onCardClick}
  ondblclick={onCardDblClick}
  onkeydown={(e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onCardDblClick();
  }}
  style:position="absolute"
  style:left="{card.posX}px"
  style:top="{card.posY}px"
  style:width="{cardWidth}px"
  style:background={background}
  style:border-radius="0px"
  style:border={border}
  style:box-shadow={isDragging
    ? "0 2px 4px rgba(0,0,0,0.07)"
    : "0 1px 2px rgba(0,0,0,0.01)"}
  style:cursor={isDragging ? "grabbing" : "grab"}
  style:user-select="none"
  style:opacity={dimmed ? 0.3 : 1}
  style:transition="opacity 0.18s, box-shadow 0.1s, background 0.1s"
  style:z-index={isDragging ? 2147483647 : zIndex}
>
  <!-- Content -->
  <div
    class={css({ padding: "8px 10px", lineHeight: "1.65", minHeight: "44px", wordBreak: "break-word", whiteSpace: "pre-wrap" })}
    style:font-size="{fontSize}px"
    style:font-family={fontFamily}
    style:color={card.content ? "var(--colors-ink-content)" : "var(--colors-neutral-placeholder)"}
  >
    {#if card.content}
      {#each linkify(card.content) as part}
        {#if part.href}
          <!-- Stop propagation so following a link doesn't start a card drag or selection. -->
          <a
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            onmousedown={(e) => e.stopPropagation()}
            onclick={(e) => e.stopPropagation()}
            class={css({ color: "select.accent", textDecoration: "underline" })}
          >{part.text}</a>
        {:else}{part.text}{/if}
      {/each}
    {:else}Empty card…{/if}
  </div>

  <!-- Footer -->
  <div class={css({ display: "flex", alignItems: "center", padding: "4px 9px 7px", fontSize: "10px", color: "neutral.muted", gap: "6px" })} style:visibility={showFooters ? "visible" : "hidden"}>
    {#if card.glueId}
      <span class={css({ display: "flex", alignItems: "center", gap: "3px" })}>
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
          <circle cx="1.5" cy="4.5" r="1.5" fill="var(--colors-neutral-muted)" />
          <circle cx="7.5" cy="4.5" r="1.5" fill="var(--colors-neutral-muted)" />
          <line x1="3" y1="4.5" x2="6" y2="4.5" stroke="var(--colors-neutral-muted)" stroke-width="1" />
        </svg>
      </span>
    {/if}

    {#if card.taskspaceId}
      <span class={css({ padding: "1px 5px", borderRadius: "2px", background: "taskspace.bg", color: "taskspace.text", fontSize: "9px", fontWeight: "500", letterSpacing: "0.05em" })}>
        taskspace
      </span>
    {/if}

    <span class={css({ display: "flex", alignItems: "center", gap: "4px", flexShrink: "0", marginLeft: "auto" })}>
      <span
        class={css({ width: "6px", height: "6px", borderRadius: "50%", flexShrink: "0" })}
        style:background={color.dot}
      ></span>
      <span class={css({ fontSize: "9.5px", color: "neutral.subtle", fontWeight: "500", letterSpacing: "0.03em", maxWidth: "90px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
        {color.name}
      </span>
    </span>
  </div>
</div>
