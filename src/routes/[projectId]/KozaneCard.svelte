<script lang="ts">
  import { css } from "styled-system/css";

  const CARD_W = 240;

  interface CardData {
    id: string;
    bundleId: string;
    content: string;
    posX: number;
    posY: number;
    tieCount: number;
    workingCopyId: string | null;
  }

  interface BundleColor {
    bg: string;
    dot: string;
    name: string;
  }

  interface Props {
    card: CardData;
    color: BundleColor;
    isSelected: boolean;
    isComposing: boolean;
    dimmed: boolean;
    isDragging: boolean;
    onCardMouseDown: (e: MouseEvent) => void;
    onCardClick: (e: MouseEvent) => void;
    onCardDblClick: () => void;
  }

  let {
    card,
    color,
    isSelected,
    isComposing,
    dimmed,
    isDragging,
    onCardMouseDown,
    onCardClick,
    onCardDblClick,
  }: Props = $props();

  let border = $derived(
    isComposing
      ? `1.5px solid ${color.dot}`
      : isSelected
        ? "1.5px solid oklch(62% 0.15 272)"
        : "1px solid #dbdbdb",
  );
</script>

<div
  role="button"
  tabindex="0"
  onmousedown={onCardMouseDown}
  onclick={onCardClick}
  ondblclick={onCardDblClick}
  onkeydown={(e) => e.key === "Enter" && onCardDblClick()}
  style:position="absolute"
  style:left="{card.posX}px"
  style:top="{card.posY}px"
  style:width="{CARD_W}px"
  style:background={isSelected ? "oklch(97% 0.025 272)" : "#ffffff"}
  style:border-radius="2px"
  style:border={border}
  style:box-shadow={isDragging
    ? "0 3px 8px rgba(0,0,0,0.2)"
    : "0 1px 2px rgba(0,0,0,0.01), 0 1px 2px rgba(0,0,0,0.02)"}
  style:cursor={isDragging ? "grabbing" : "grab"}
  style:user-select="none"
  style:opacity={dimmed ? 0.3 : 1}
  style:transition="opacity 0.18s, box-shadow 0.1s, background 0.1s"
  style:z-index={isDragging ? 200 : isSelected ? 10 : 1}
>
  <!-- Content -->
  <div
    class={css({ padding: "10px 10px 6px", fontSize: "11.5px", lineHeight: "1.65", fontFamily: "mono", minHeight: "44px", wordBreak: "break-word", textWrap: "pretty" })}
    style:color={card.content ? "#575757" : "#b4b4b4"}
  >
    {card.content || "Empty card…"}
  </div>

  <!-- Footer -->
  <div class={css({ display: "flex", alignItems: "center", padding: "4px 9px 7px", fontSize: "10px", color: "warm.muted", gap: "6px" })}>
    {#if card.tieCount > 0}
      <span class={css({ display: "flex", alignItems: "center", gap: "3px" })}>
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
          <circle cx="1.5" cy="4.5" r="1.5" fill="#b0aaa2" />
          <circle cx="7.5" cy="4.5" r="1.5" fill="#b0aaa2" />
          <line x1="3" y1="4.5" x2="6" y2="4.5" stroke="#b0aaa2" stroke-width="1" />
        </svg>
        {card.tieCount}
      </span>
    {/if}

    {#if card.workingCopyId}
      <span class={css({ padding: "1px 5px", borderRadius: "3px", background: "oklch(93% 0.055 158)", color: "oklch(48% 0.15 158)", fontSize: "9px", fontWeight: "500", letterSpacing: "0.05em" })}>
        wc
      </span>
    {/if}

    <span class={css({ display: "flex", alignItems: "center", gap: "4px", flexShrink: "0", marginLeft: "auto" })}>
      <span
        class={css({ width: "6px", height: "6px", borderRadius: "50%", flexShrink: "0" })}
        style:background={color.dot}
      ></span>
      <span class={css({ fontSize: "9.5px", color: "warm.subtle", fontWeight: "500", letterSpacing: "0.03em", maxWidth: "90px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
        {color.name}
      </span>
    </span>
  </div>
</div>
