<script lang="ts">
  import { css, cx } from "styled-system/css";

  // Point right when closed and rotate down when open.
  let { expanded }: { expanded: boolean } = $props();

  const arrowClass = css({
    display: "flex",
    flexShrink: "0",
    color: "neutral.subtle",
    transition: "transform 0.12s ease",
  });
  const openClass = css({ transform: "rotate(90deg)" });
</script>

<span class={cx(arrowClass, expanded && openClass)}>
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M3.75 2.25 6.5 5 3.75 7.75" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</span>
