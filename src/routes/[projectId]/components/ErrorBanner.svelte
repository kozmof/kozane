<script lang="ts">
  import { css } from "styled-system/css";

  let {
    message,
    onDismiss,
  }: {
    message: string;
    onDismiss: () => void;
  } = $props();
</script>

<div
  class={css({
    position: "absolute",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "52",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 14px",
    background: "state.error",
    color: "#fff",
    borderRadius: "7px",
    fontSize: "12.5px",
    boxShadow: "0 2px 10px rgba(0,0,0,0.18)",
    whiteSpace: "nowrap",
  })}
  role="alert"
>
  <span>{message}</span>
  <button
    class={css({
      background: "none",
      border: "none",
      color: "rgba(255,255,255,0.75)",
      cursor: "pointer",
      fontSize: "15px",
      lineHeight: "1",
      padding: "0",
      flexShrink: "0",
    })}
    onclick={onDismiss}
  >×</button>
</div>
