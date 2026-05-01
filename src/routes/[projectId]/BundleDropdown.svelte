<script lang="ts">
  interface Bundle {
    id: string;
    name: string;
    bg: string;
    dot: string;
  }

  interface Props {
    bundles: Bundle[];
    bundleId: string;
    onChange: (id: string) => void;
  }

  let { bundles, bundleId, onChange }: Props = $props();

  let open = $state(false);
  let dropdownEl: HTMLDivElement;

  let active = $derived(bundles.find((b) => b.id === bundleId) ?? bundles[0]);

  $effect(() => {
    if (!open) return;
    function handleDown(e: MouseEvent) {
      if (!dropdownEl?.contains(e.target as Node)) open = false;
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  });
</script>

<div bind:this={dropdownEl} class="wrapper">
  <button
    class="trigger"
    style:border-color={open ? active?.dot : "#e6e1d8"}
    style:background={open ? active?.bg : "transparent"}
    onmousedown={(e) => {
      e.preventDefault();
      open = !open;
    }}
  >
    <span class="dot" style:background={active?.dot}></span>
    <span class="label">{active?.name ?? "Bundle"}</span>
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" class="chevron">
      <path
        d="M1.5 3L4 5.5L6.5 3"
        stroke="#1c1a17"
        stroke-width="1.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>

  {#if open}
    <div class="popover">
      {#each bundles as b (b.id)}
        {@const isActive = b.id === bundleId}
        <button
          class="option"
          style:background={isActive ? b.bg : "transparent"}
          onmousedown={(e) => {
            e.preventDefault();
            onChange(b.id);
            open = false;
          }}
        >
          <span class="dot" style:background={b.dot}></span>
          {b.name}
          {#if isActive}
            <svg
              width="10"
              height="8"
              viewBox="0 0 10 8"
              fill="none"
              style:margin-left="auto"
            >
              <path
                d="M1 4l3 3 5-6"
                stroke={b.dot}
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrapper {
    position: relative;
    flex-shrink: 0;
  }

  .trigger {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px 3px 6px;
    border: 1px solid;
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    color: #1c1a17;
    transition: all 0.1s;
  }

  .label {
    max-width: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron {
    opacity: 0.5;
    margin-left: 1px;
    flex-shrink: 0;
  }

  .popover {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    background: #ffffff;
    border: 1px solid #e6e1d8;
    border-radius: 7px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
    padding: 4px;
    min-width: 160px;
    z-index: 100;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    color: #1c1a17;
    text-align: left;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
</style>
