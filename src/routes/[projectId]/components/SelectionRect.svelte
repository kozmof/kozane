<script lang="ts">
  let {
    rect,
  }: {
    rect: { x: number; y: number; w: number; h: number };
  } = $props();
</script>

<div
  style:position="absolute"
  style:left="{rect.x}px"
  style:top="{rect.y}px"
  style:width="{rect.w}px"
  style:height="{rect.h}px"
  style:border="1px solid var(--colors-select-accent)"
  style:background="color-mix(in oklch, var(--colors-select-accent) 16%, transparent)"
  style:pointer-events="none"
  style:z-index="300"
></div>
