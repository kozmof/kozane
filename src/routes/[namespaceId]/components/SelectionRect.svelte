<script lang="ts">
  let {
    rect,
    accent = "var(--colors-select-accent)",
  }: {
    rect: { x: number; y: number; w: number; h: number };
    /**
     * What the rectangle is drawn in. Defaults to the selection accent, which is what a
     * marquee is. A scope area being drawn passes its own, so the two rectangles — one that
     * ends at mouseup, one that is about to become a frame — do not read as the same gesture.
     */
    accent?: string;
  } = $props();
</script>

<div
  style:position="absolute"
  style:left="{rect.x}px"
  style:top="{rect.y}px"
  style:width="{rect.w}px"
  style:height="{rect.h}px"
  style:border="1px solid {accent}"
  style:background="color-mix(in oklch, {accent} 16%, transparent)"
  style:pointer-events="none"
  style:z-index="300"
></div>
