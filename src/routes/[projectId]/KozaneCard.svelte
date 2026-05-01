<script lang="ts">
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
        : "1px solid #e4e4e4",
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
    ? "0 5px 14px rgba(0,0,0,0.2)"
    : "0 1px 2px rgba(0,0,0,0.03), 0 4px 6px rgba(0,0,0,0.02)"}
  style:cursor={isDragging ? "grabbing" : "grab"}
  style:user-select="none"
  style:opacity={dimmed ? 0.3 : 1}
  style:transition="opacity 0.18s, box-shadow 0.1s, background 0.1s"
  style:z-index={isDragging ? 200 : isSelected ? 10 : 1}
>
  <!-- Content -->
  <div class="content" style:color={card.content ? "#575757" : "#b4b4b4"}>
    {card.content || "Empty card…"}
  </div>

  <!-- Footer -->
  <div class="footer">
    {#if card.tieCount > 0}
      <span class="ties">
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
          <circle cx="1.5" cy="4.5" r="1.5" fill="#b0aaa2" />
          <circle cx="7.5" cy="4.5" r="1.5" fill="#b0aaa2" />
          <line x1="3" y1="4.5" x2="6" y2="4.5" stroke="#b0aaa2" stroke-width="1" />
        </svg>
        {card.tieCount}
      </span>
    {/if}

    {#if card.workingCopyId}
      <span class="wc-badge">wc</span>
    {/if}

    <span class="bundle-tag" style:margin-left="auto">
      <span class="bundle-dot" style:background={color.dot}></span>
      <span class="bundle-name">{color.name}</span>
    </span>
  </div>
</div>

<style>
  .content {
    padding: 10px 10px 6px;
    font-size: 11.5px;
    line-height: 1.65;
    font-family: "IBM Plex Mono", monospace;
    min-height: 44px;
    word-break: break-word;
    text-wrap: pretty;
  }

  .footer {
    display: flex;
    align-items: center;
    padding: 4px 9px 7px;
    font-size: 10px;
    color: #b0aaa2;
    gap: 6px;
    border-top: 1px solid #f0ebe3;
  }

  .ties {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .wc-badge {
    padding: 1px 5px;
    border-radius: 3px;
    background: oklch(93% 0.055 158);
    color: oklch(48% 0.15 158);
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.05em;
  }

  .bundle-tag {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .bundle-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .bundle-name {
    font-size: 9.5px;
    color: #9e9890;
    font-weight: 500;
    letter-spacing: 0.03em;
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
