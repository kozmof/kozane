<script lang="ts">
  import type { TaskspaceEntryKind } from "$lib/types";

  /**
   * Shared file, folder, and parent-directory glyphs for taskspace views. Use `currentColor`
   * so the caller controls normal, hovered, and dimmed states.
   */
  let {
    kind,
    size = 10,
  }: {
    /** `"up"` is the step out of a directory, which is not an entry kind the server has. */
    kind: TaskspaceEntryKind | "up";
    size?: number;
  } = $props();

  // Every path below is drawn in a 10×10 box and scaled by the viewBox, so one stroke width
  // reads the same at any size the callers ask for.
  const stroke = $derived(11 / size);
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 10 10"
  fill="none"
  aria-hidden="true"
  style="flex-shrink:0"
>
  {#if kind === "directory"}
    <path
      d="M1 3V2h3l1 1h4v5H1z"
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linejoin="round"
    />
  {:else if kind === "up"}
    <!-- Draw an arrow leaving the folder to indicate moving up one level. -->
    <path
      d="M1 3V2h3l1 1h4v5H1z"
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linejoin="round"
    />
    <path
      d="M5 7V4.6M3.8 5.6 5 4.4l1.2 1.2"
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {:else}
    <!-- A file, a symlink, and whatever else the filesystem holds all share the sheet. The
         symlink earns the extra stroke because it is the one of the three that cannot be
         opened, and the tooltip saying so is only there on hover. -->
    <path
      d="M2.5 1h3l2 2v6h-5z"
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linejoin="round"
    />
    {#if kind === "symlink"}
      <path
        d="M3.8 6.2h2.4"
        stroke="currentColor"
        stroke-width={stroke}
        stroke-linecap="round"
      />
    {/if}
  {/if}
</svg>
