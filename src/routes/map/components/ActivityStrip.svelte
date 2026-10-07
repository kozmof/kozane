<script lang="ts">
  import { css } from "styled-system/css";
  import type { ActivityCell } from "../lib/activity.js";

  /**
   * Card-change heatmap with one week per column and one day per cell. Each cell filters the
   * map to cards changed that day.
   */
  let {
    cells,
    selectedDay,
    rangeLabel,
    dayHref,
  }: {
    cells: ActivityCell[];
    selectedDay: string | null;
    /** What the strip covers, shown while no day is picked. */
    rangeLabel: string;
    /** The map narrowed to `day`, or widened back out of it for null. */
    dayHref: (day: string | null) => string;
  } = $props();

  const ACTIVITY_COLORS = [
    "oklch(94% 0.008 250)",
    "oklch(88% 0.07 250)",
    "oklch(76% 0.13 250)",
    "oklch(64% 0.17 250)",
    "oklch(50% 0.16 250)",
  ] as const;

  const activityLabel = (day: string, cards: number) =>
    `${day}: ${cards} card ${cards === 1 ? "change" : "changes"}`;
</script>

<section
  aria-label="Card change activity"
  class={css({
    position: "absolute",
    zIndex: "3",
    left: "50%",
    bottom: "12px",
    transform: "translateX(-50%)",
    maxWidth: "calc(100% - 150px)",
    boxSizing: "border-box",
    padding: "8px 10px",
    backgroundColor: "ink.light",
    border: "1px solid token(colors.neutral.dim)",
    borderRadius: "3px",
    boxShadow: "0 1px 6px rgba(0,0,0,0.025)",
    fontFamily: "mono",
  })}
>
  <div
    class={css({
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: "12px",
      marginBottom: "6px",
      color: "neutral.subtle",
      fontSize: "10px",
    })}
  >
    <span>{selectedDay ?? rangeLabel}</span>
    {#if selectedDay}
      <a
        href={dayHref(null)}
        class={css({
          color: "neutral.secondary",
          textDecoration: "none",
          _hover: { color: "ink.black" },
        })}>Clear</a
      >
    {/if}
  </div>
  <div
    class={css({
      display: "grid",
      gridAutoFlow: "column",
      gridTemplateRows: "repeat(7, 9px)",
      gridAutoColumns: "9px",
      gap: "3px",
      overflowX: "auto",
      scrollbarWidth: "thin",
    })}
  >
    {#each cells as cell (cell.week + "-" + cell.weekday)}
      {#if cell.day}
        <a
          href={dayHref(selectedDay === cell.day ? null : cell.day)}
          title={activityLabel(cell.day, cell.cards)}
          aria-label={activityLabel(cell.day, cell.cards)}
          aria-current={selectedDay === cell.day ? "date" : undefined}
          style="width: 9px; height: 9px; background-color: {ACTIVITY_COLORS[cell.level]}"
          class={css({
            display: "block",
            boxSizing: "border-box",
            borderRadius: "1px",
            border: "1px solid rgba(0,0,0,0.055)",
            _hover: { outline: "1px solid token(colors.ink.black)" },
          })}
        ></a>
      {:else}
        <span aria-hidden="true" style="width: 9px; height: 9px"></span>
      {/if}
    {/each}
  </div>
</section>
