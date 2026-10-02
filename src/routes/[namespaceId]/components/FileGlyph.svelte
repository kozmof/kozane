<script lang="ts">
  import type { TaskspaceEntryKind } from "$lib/types";

  /**
   * The mark drawn beside, or above, the name of one thing in a taskspace.
   *
   * One component rather than a snippet apiece because three surfaces now draw these: the
   * panel's tree, which had the file sheet as a local snippet, and the icon strip under a
   * scope frame, which needs the same sheet at a larger size plus a folder and a way back
   * out. A file that looks like a file in one place and not the other is the kind of drift
   * that is easier to prevent than to notice.
   *
   * `currentColor` throughout, so the caller sets the colour on the row or cell and a
   * hovered or dimmed state carries to the glyph without the glyph knowing about either.
   * The panel's tree used a hard-coded `neutral.iconDim` and sets that colour on its rows.
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
    <!-- The folder above, with the arrow leaving it: a step out rather than a step in. -->
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
