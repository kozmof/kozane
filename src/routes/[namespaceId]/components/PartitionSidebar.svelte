<script lang="ts">
  import { css, cx } from "styled-system/css";
  import { base } from "$app/paths";
  import type { CardWithGlue, PartitionWithColor } from "$lib/types";

  let {
    visible,
    panelWidth,
    cards,
    partitions,
    activePartition = $bindable(),
    newPartitionName = $bindable(),
    onCreatePartition,
    onDeletePartition,
    readonly = false,
  }: {
    visible: boolean;
    panelWidth: number;
    cards: CardWithGlue[];
    partitions: PartitionWithColor[];
    activePartition: string | null;
    newPartitionName: string;
    onCreatePartition: () => void;
    onDeletePartition: (partitionId: string) => void;
    // Read-only export: keep partition filtering, hide create/delete controls.
    readonly?: boolean;
  } = $props();

  const dotClass = css({ width: "7px", height: "7px", borderRadius: "50%", flexShrink: "0" });
  const flex1Class = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });
  const countClass = css({ fontSize: "10.5px", color: "neutral.subtle", flexShrink: "0" });

  const sideBtnBase = css({
    display: "flex",
    alignItems: "center",
    gap: "9px",
    padding: "7px 10px",
    width: "100%",
    background: "transparent",
    border: "none",
    borderRadius: "2px",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "12.5px",
    color: "ink.black",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    overflow: "hidden",
  });
  const sideBtnActiveClass = css({ backgroundColor: "neutral.bg" });

  function sideBtn(active: boolean) {
    return cx(sideBtnBase, active && sideBtnActiveClass);
  }
</script>

<aside
  class={css({
    flexShrink: "0",
    backgroundColor: "ink.light",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    transition: "width 0.22s ease",
    borderRight: "1px solid token(colors.neutral.dim)",
  })}
  style:width={visible ? `${panelWidth}px` : "0"}
>
  <div class={css({ padding: "10px 12px", borderBottom: "1px solid token(colors.neutral.dim)" })}>
    <a
      title="to namespaces"
      href="{base}/"
      class={css({
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 8px",
        borderRadius: "2px",
        textDecoration: "none",
        color: "ink.secondary",
        fontSize: "12.5px",
        "&:hover": { backgroundColor: "neutral.bg", color: "ink.black" },
      })}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M8 1L3 6l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </a>
  </div>

  <div class={css({ flex: "1", overflowY: "auto", padding: "14px 0 8px" })}>
    <div class={css({ padding: "0 8px", display: "flex", flexDirection: "column", gap: "1px" })}>
      <button class={sideBtn(activePartition === null)} onclick={() => (activePartition = null)}>
        <span class={dotClass} style:background="var(--colors-neutral-faded)"></span>
        <span class={flex1Class}>All cards</span>
        <span class={countClass}>{cards.length}</span>
      </button>

      {#each partitions as b (b.id)}
        {@const active = activePartition === b.id}
        <div class={css({ position: "relative", "&:hover .partition-delete": { opacity: "1" } })}>
          <button
            class={cx(sideBtn(active), css({ paddingRight: "28px" }))}
            style:background={active ? b.bg : "transparent"}
            onclick={() => (activePartition = active ? null : b.id)}
          >
            <span class={dotClass} style:background={b.dot}></span>
            <span class={flex1Class}>{b.name}</span>
            <span class={countClass}>{cards.filter((c) => c.partitionId === b.id).length}</span>
          </button>
          {#if !b.isDefault && !readonly}
            <button
              class={cx("partition-delete", css({
                position: "absolute",
                right: "6px",
                top: "50%",
                transform: "translateY(-50%)",
                width: "18px",
                height: "18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                cursor: "pointer",
                borderRadius: "2px",
                fontSize: "13px",
                color: "neutral.subtle",
                opacity: "0",
                transition: "opacity 0.12s, color 0.12s",
                "&:hover": { color: "state.error" },
              }))}
              title="Delete partition"
              onclick={(e) => { e.stopPropagation(); onDeletePartition(b.id); }}
            >×</button>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  {#if !readonly}
    <div class={css({ padding: "10px", borderTop: "1px solid token(colors.neutral.dim)", display: "flex", gap: "5px" })}>
      <input
        class={css({ flex: "1", padding: "7px 10px", border: "1px solid token(colors.neutral.dim)", borderRadius: "2px", fontSize: "11.5px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
        bind:value={newPartitionName}
        onkeydown={(e) => e.key === "Enter" && onCreatePartition()}
      />
      <button
        class={css({ padding: "7px 11px", backgroundColor: "ink.black", color: "ink.light", border: "none", borderRadius: "2px", cursor: "pointer", fontSize: "14px", fontFamily: "inherit", lineHeight: "1" })}
        onclick={onCreatePartition}
      >+</button>
    </div>
  {/if}
</aside>
