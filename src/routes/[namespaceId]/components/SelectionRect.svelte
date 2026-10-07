<script lang="ts">
  let {
    rect,
    accent = "var(--colors-select-accent)",
  }: {
    rect: { x: number; y: number; w: number; h: number };
    /**
     * Rectangle color, defaulting to the selection accent. Scope drawing supplies a different
     * color to distinguish it from marquee selection.
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
