<script lang="ts">
  import { css, cx } from "../../styles/css.js";

  let {
    what,
    onRename,
    onDelete,
    deleteDisabledReason = null,
  }: {
    /** The row's name, for button labels such as `Rename "notes"`. */
    what: string;
    onRename?: () => void;
    onDelete?: () => void;
    /** Shown as the delete button's title when deleting is not allowed. */
    deleteDisabledReason?: string | null;
  } = $props();

  // Share `hover-reveal` with the creation buttons, so one row hover reveals them all.
  const btnClass = css({
    width: "20px",
    height: "20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
    background: "none",
    border: "none",
    cursor: "pointer",
    borderRadius: "2px",
    color: "neutral.subtle",
    opacity: "0",
    transition: "opacity 0.12s, color 0.12s",
    "&:hover": { color: "ink.black" },
    "&:focus-visible": { opacity: "1" },
    "&:disabled": { cursor: "default", color: "neutral.faded" },
  });
  const deleteClass = css({ "&:hover:not(:disabled)": { color: "state.error" } });
</script>

{#if onRename}
  <button
    class={cx("hover-reveal", btnClass)}
    title={`Rename "${what}"`}
    aria-label={`Rename "${what}"`}
    onclick={(e) => { e.stopPropagation(); onRename(); }}
  >
    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M6.6 1.6 8.4 3.4 3.4 8.4H1.6V6.6z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
    </svg>
  </button>
{/if}
{#if onDelete}
  <button
    class={cx("hover-reveal", btnClass, deleteClass)}
    title={deleteDisabledReason ?? `Delete "${what}"`}
    aria-label={`Delete "${what}"`}
    disabled={deleteDisabledReason !== null}
    onclick={(e) => { e.stopPropagation(); onDelete(); }}
  >
    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M1.5 2.6h7M4 2.6V1.5h2v1.1M2.5 2.6l.5 6h4l.5-6" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  </button>
{/if}
