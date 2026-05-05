<script lang="ts">
  import { css, cx } from "styled-system/css";
  import type { Scope, ScopeRel, WorkingCopy } from "$lib/types";

  let {
    visible,
    panelWidth,
    scopes,
    scopeRels,
    workingCopies,
    selectedCards,
    activeScope = $bindable(),
    newScopeName = $bindable(),
    newWcName = $bindable(),
    onCreateScope,
    onDeleteScope,
    onAddToScope,
    onRemoveFromScope,
    onCreateWorkingCopy,
  }: {
    visible: boolean;
    panelWidth: number;
    scopes: Scope[];
    scopeRels: ScopeRel[];
    workingCopies: WorkingCopy[];
    selectedCards: Set<string>;
    activeScope: string | null;
    newScopeName: string;
    newWcName: string;
    onCreateScope: () => void;
    onDeleteScope: (scopeId: string) => void;
    onAddToScope: (scopeId: string) => void;
    onRemoveFromScope: (scopeId: string) => void;
    onCreateWorkingCopy: () => void;
  } = $props();

  const flex1Class = css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis" });
  const countClass = css({ fontSize: "10.5px", color: "warm.subtle", flexShrink: "0" });

  const sideBtnBase = css({
    display: "flex",
    alignItems: "center",
    gap: "9px",
    padding: "7px 10px",
    width: "100%",
    background: "transparent",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "12.5px",
    color: "ink.black",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    overflow: "hidden",
  });
  const sideBtnActiveClass = css({ backgroundColor: "warm.bg" });

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
    borderLeft: "1px solid token(colors.warm.dim)",
  })}
  style:width={visible ? `${panelWidth}px` : "0"}
>
  <div class={css({ flex: "1", overflowY: "auto", padding: "8px 8px 0", display: "flex", flexDirection: "column", gap: "1px" })}>
    {#each scopes as scope (scope.id)}
      {@const active = activeScope === scope.id}
      <div class={cx(
        css({ borderRadius: "6px", overflow: "hidden", border: "1px solid transparent" }),
        active && css({ borderColor: "warm.scroll" }),
      )}>
        <div class={css({ display: "flex", alignItems: "center", position: "relative", "&:hover .scope-delete": { opacity: "1" } })}>
          <button
            class={cx(sideBtn(active), css({ paddingRight: "28px" }))}
            onclick={() => (activeScope = active ? null : scope.id)}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <rect x="1" y="1" width="8" height="8" rx="1" stroke="var(--colors-warm-icon-dim)" stroke-width="1.2" />
              <path d="M3 5h4M3 3.5h2" stroke="var(--colors-warm-icon-dim)" stroke-width="1" stroke-linecap="round" />
            </svg>
            <span class={flex1Class}>{scope.name}</span>
            <span class={countClass}>
              {scopeRels.filter((r) => r.scopeId === scope.id).length}
            </span>
          </button>
          <button
            class={cx("scope-delete", css({
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
              borderRadius: "3px",
              fontSize: "13px",
              color: "warm.subtle",
              opacity: "0",
              transition: "opacity 0.12s, color 0.12s",
              "&:hover": { color: "state.error" },
            }))}
            title="Delete scope"
            onclick={(e) => { e.stopPropagation(); onDeleteScope(scope.id); }}
          >×</button>
        </div>

        {#if selectedCards.size > 0}
          {@const allInScope = [...selectedCards].every((cid) => scopeRels.some((r) => r.scopeId === scope.id && r.cardId === cid))}
          <button
            class={css({
              width: "100%",
              padding: "6px 10px",
              backgroundColor: allInScope ? "warm.faded" : "ink.black",
              color: allInScope ? "ink.secondary" : "ink.light",
              border: "none",
              borderTop: "1px solid token(colors.warm.dim)",
              cursor: "pointer",
              fontSize: "11px",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "6px",
            })}
            onclick={() => allInScope ? onRemoveFromScope(scope.id) : onAddToScope(scope.id)}
          >
            <span>{allInScope ? "Remove from scope" : "Add to scope"}</span>
            <span>{allInScope ? "−" : "→"}</span>
          </button>
        {/if}

        {#if active}
          {@const scopeWcs = workingCopies.filter((wc) => wc.scopeId === scope.id && wc.path !== null)}
          {#if scopeWcs.length > 0}
            <div class={css({ borderTop: "1px solid token(colors.warm.dim)", padding: "4px 6px", display: "flex", flexDirection: "column", gap: "1px" })}>
              {#each scopeWcs as wc (wc.id)}
                <div class={css({
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 6px",
                  borderRadius: "4px",
                  fontSize: "11.5px",
                  color: "ink.secondary",
                })}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="flex-shrink:0">
                    <rect x="1" y="2.5" width="8" height="6" rx="1" stroke="var(--colors-warm-icon-dim)" stroke-width="1.2" />
                    <path d="M1 4.5h8" stroke="var(--colors-warm-icon-dim)" stroke-width="1" />
                    <path d="M3 1.5h4v1.5H3z" fill="var(--colors-warm-icon-dim)" />
                  </svg>
                  <span class={css({ flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>{wc.name}</span>
                </div>
              {/each}
            </div>
          {/if}
          <div class={css({ padding: "8px", borderTop: "1px solid token(colors.warm.dim)", display: "flex", gap: "5px" })}>
            <input
              class={css({ flex: "1", padding: "6px 8px", border: "1px solid token(colors.warm.dim)", borderRadius: "6px", fontSize: "11.5px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
              placeholder="working copy name"
              bind:value={newWcName}
              onkeydown={(e) => e.key === "Enter" && onCreateWorkingCopy()}
            />
            <button
              class={css({ padding: "6px 11px", backgroundColor: "ink.black", color: "ink.light", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "14px", fontFamily: "inherit", lineHeight: "1" })}
              onclick={onCreateWorkingCopy}
            >+</button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <div class={css({ padding: "10px", borderTop: "1px solid token(colors.warm.dim)", marginTop: "8px", display: "flex", gap: "5px" })}>
    <input
      class={css({ flex: "1", padding: "7px 10px", border: "1px solid token(colors.warm.dim)", borderRadius: "6px", fontSize: "11.5px", background: "ink.white", fontFamily: "inherit", color: "ink.black" })}
      bind:value={newScopeName}
      onkeydown={(e) => e.key === "Enter" && onCreateScope()}
    />
    <button
      class={css({ padding: "7px 11px", backgroundColor: "ink.black", color: "ink.light", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "14px", fontFamily: "inherit", lineHeight: "1" })}
      onclick={onCreateScope}
    >+</button>
  </div>
</aside>
