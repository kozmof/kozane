<script lang="ts">
  import InlineNameInput from "./InlineNameInput.svelte";
  import { css, cx } from "../../styles/css.js";
  import type { PartitionWithColor } from "@kozane/core";

  let {
    visible,
    namespacesHref,
    panelWidth,
    partitions,
    activePartition = $bindable(),
    newPartitionName = $bindable(),
    onCreatePartition,
    onDeletePartition,
    onRenamePartition,
    readonly = false,
  }: {
    visible: boolean;
    namespacesHref: string;
    panelWidth: number;
    partitions: PartitionWithColor[];
    activePartition: string | null;
    newPartitionName: string;
    onCreatePartition: () => void;
    onDeletePartition: (partitionId: string) => void;
    onRenamePartition?: (partitionId: string, name: string) => Promise<string | null>;
    // A read-only export keeps partition filtering but hides the create and delete controls.
    readonly?: boolean;
  } = $props();

  function startRename(id: string) {
    if (!readonly && onRenamePartition) editingPartitionId = id;
  }
  let editingPartitionId: string | null = $state(null);

  const dotClass = css({ width: "7px", height: "7px", borderRadius: "50%", flexShrink: "0" });
  const flex1Class = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });

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

<!-- Float over the left edge of the board, so opening the panel never moves the canvas. -->
<aside
  class={css({
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    zIndex: "55",
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
      href={namespacesHref}
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
      <button class={sideBtn(activePartition === null)} onclick={() => { activePartition = null; }}>
        <span class={dotClass} style:background="var(--colors-neutral-faded)"></span>
        <span class={flex1Class}>All cards</span>
      </button>

      {#each partitions as b (b.id)}
        {@const active = activePartition === b.id}
        <div class={css({ position: "relative", "&:hover .partition-delete": { opacity: "1" }, "&:hover .partition-edit": { opacity: "1", pointerEvents: "auto" }, "&:focus-within .partition-edit": { opacity: "1", pointerEvents: "auto" } })}>
          {#if editingPartitionId === b.id && !readonly && onRenamePartition}
            <InlineNameInput value={b.name} label="Partition name" onCancel={() => { editingPartitionId = null; }} onSubmit={async (name) => {
              const error = await onRenamePartition!(b.id, name);
              if (!error) editingPartitionId = null;
              return error;
            }} />
          {:else}
          <button
            aria-pressed={active}
            title={!readonly && onRenamePartition ? "Double-click, press F2, or use the edit button to rename partition" : undefined}
            ondblclick={(event) => { event.preventDefault(); event.stopPropagation(); startRename(b.id); }}
            onkeydown={(event) => { if (event.key === "F2" && !readonly && onRenamePartition) { event.preventDefault(); event.stopPropagation(); startRename(b.id); } }}
            class={cx(sideBtn(active), css({ paddingRight: !readonly && onRenamePartition ? "50px" : "28px" }))}
            style:background={active ? b.bg : "transparent"}
            onclick={() => { activePartition = b.id; }}
          >
            <span class={dotClass} style:background={b.dot}></span>
            <span class={flex1Class}>{b.name}</span>
          </button>
          {/if}
          {#if !readonly && onRenamePartition && editingPartitionId !== b.id}
            <button
              class={cx("partition-edit", css({ opacity: "0", pointerEvents: "none", transition: "opacity 0.12s", position: "absolute", right: "28px", top: "50%", transform: "translateY(-50%)", width: "18px", height: "18px", display: "flex", alignItems: "center", justifyContent: "center", padding: "0", background: "none", border: "none", cursor: "pointer", borderRadius: "2px", color: "neutral.subtle", "&:hover": { color: "ink.black" } }))}
              aria-label={`Rename ${b.name}`}
              title="Rename partition"
              onclick={() => startRename(b.id)}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M10.5 2.5l3 3M3 10l7.5-7.5a1.4 1.4 0 012 0l1 1a1.4 1.4 0 010 2L6 13l-4 1 1-4z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          {/if}
          {#if !b.isDefault && !readonly && editingPartitionId !== b.id}
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
